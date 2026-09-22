import { pool } from '../../db/connect.js';
import { parseCents } from '../../utils/money.js';
import * as customerService from './customerService.js';
import * as vendorService from './vendorService.js';
import { noteOwnAppliedCentsSubquery, settledCentsSubquery } from './settlementSql.js';
import { resolveControlAccounts } from './reportService.js';
import {
  AGING_BUCKETS,
  type AgingBucket,
  type PartyKind,
  type PartyLedger,
  type PartyLedgerAllocation,
  type PartyLedgerEntryKind,
  type PartyLedgerRow,
  type PartyOpenItem,
  type PartyOpenItems,
} from '../../types/ledger-core.js';

/**
 * Customer and vendor accounts — each party's subsidiary ledger under the
 * AR/AP control account (Phase 25).
 *
 * There is no GL account per party and no party column on `ledger_lines`. A
 * control-account line belongs to a party when its journal entry is the
 * `journal_entry_id` or `void_journal_entry_id` of one of that party's
 * invoices, bills, payments or (Phase 26) credit/debit notes — FK-constrained
 * columns that already exist, so
 * attribution is derived on every read and needs no migration. Lines no
 * document owns (legacy manual journals, FX revaluation) belong to no party;
 * `/reports/ar-aging`'s `reconciles` is what surfaces them.
 *
 * Every query is scoped by `org_id` (guardrails rule 1). The only values
 * interpolated into SQL are the frozen `PARTY_CONFIG` constants below, never
 * request input (rule 4). Amounts are base-currency integer cents (rule 3) —
 * the same currency the control account and aging report in.
 */

interface PartyConfig {
  partyTable: 'customers' | 'vendors';
  docTable: 'invoices' | 'bills';
  partyColumn: 'customer_id' | 'vendor_id';
  numberColumn: 'invoice_number' | 'vendor_reference';
  dateColumn: 'issue_date' | 'bill_date';
  openStatus: 'ISSUED' | 'POSTED';
  docKind: 'INVOICE' | 'BILL';
  voidKind: 'INVOICE_VOID' | 'BILL_VOID';
  allocationColumn: 'invoice_id' | 'bill_id';
  /** AR is an Asset (debit-normal); AP a Liability (credit-normal). */
  debitNormal: boolean;
  /** Phase 26 — the party's correcting documents. */
  noteTable: 'credit_notes' | 'debit_notes';
  noteNumberColumn: 'credit_note_number' | 'debit_note_number';
  noteKind: 'CREDIT_NOTE' | 'DEBIT_NOTE';
  noteVoidKind: 'CREDIT_NOTE_VOID' | 'DEBIT_NOTE_VOID';
  noteSubqueryKind: 'credit' | 'debit';
}

const PARTY_CONFIG: Record<PartyKind, PartyConfig> = {
  CUSTOMER: {
    partyTable: 'customers',
    docTable: 'invoices',
    partyColumn: 'customer_id',
    numberColumn: 'invoice_number',
    dateColumn: 'issue_date',
    openStatus: 'ISSUED',
    docKind: 'INVOICE',
    voidKind: 'INVOICE_VOID',
    allocationColumn: 'invoice_id',
    debitNormal: true,
    noteTable: 'credit_notes',
    noteNumberColumn: 'credit_note_number',
    noteKind: 'CREDIT_NOTE',
    noteVoidKind: 'CREDIT_NOTE_VOID',
    noteSubqueryKind: 'credit',
  },
  VENDOR: {
    partyTable: 'vendors',
    docTable: 'bills',
    partyColumn: 'vendor_id',
    numberColumn: 'vendor_reference',
    dateColumn: 'bill_date',
    openStatus: 'POSTED',
    docKind: 'BILL',
    voidKind: 'BILL_VOID',
    allocationColumn: 'bill_id',
    debitNormal: false,
    noteTable: 'debit_notes',
    noteNumberColumn: 'debit_note_number',
    noteKind: 'DEBIT_NOTE',
    noteVoidKind: 'DEBIT_NOTE_VOID',
    noteSubqueryKind: 'debit',
  },
};

export interface PartyLedgerOptions {
  page: number;
  limit: number;
  from: string | null;
  to: string | null;
}

interface Party {
  kind: PartyKind;
  id: string;
  name: string;
}

/** 404s through the party's own service — also the cross-tenant answer. */
async function loadParty(orgId: string, partyId: string, kind: PartyKind): Promise<Party> {
  const party =
    kind === 'CUSTOMER'
      ? await customerService.getCustomerById(orgId, partyId)
      : await vendorService.getVendorById(orgId, partyId);
  return { kind, id: party.id, name: party.name };
}

/**
 * `party_rows`: one row per (journal entry, owning document) with the entry's
 * control-account lines summed. A payment settling three invoices posts three
 * control lines; the party sees one payment row, with the split in
 * `allocations`. `$1` org, `$2` party, `$3` control account.
 */
function buildPartyRowsCte(config: PartyConfig): string {
  return `party_entries AS (
    SELECT '${config.docKind}'::text AS kind, d.id AS document_id,
           d.${config.numberColumn} AS document_number, d.journal_entry_id AS entry_id
      FROM ${config.docTable} d
     WHERE d.org_id = $1 AND d.${config.partyColumn} = $2 AND d.journal_entry_id IS NOT NULL
    UNION ALL
    SELECT '${config.voidKind}'::text, d.id, d.${config.numberColumn}, d.void_journal_entry_id
      FROM ${config.docTable} d
     WHERE d.org_id = $1 AND d.${config.partyColumn} = $2 AND d.void_journal_entry_id IS NOT NULL
    UNION ALL
    SELECT 'PAYMENT'::text, p.id, p.reference, p.journal_entry_id
      FROM payments p
     WHERE p.org_id = $1 AND p.${config.partyColumn} = $2
    UNION ALL
    SELECT 'PAYMENT_VOID'::text, p.id, p.reference, p.void_journal_entry_id
      FROM payments p
     WHERE p.org_id = $1 AND p.${config.partyColumn} = $2 AND p.void_journal_entry_id IS NOT NULL
    UNION ALL
    SELECT '${config.noteKind}'::text, n.id, n.${config.noteNumberColumn}, n.journal_entry_id
      FROM ${config.noteTable} n
     WHERE n.org_id = $1 AND n.${config.partyColumn} = $2 AND n.journal_entry_id IS NOT NULL
    UNION ALL
    SELECT '${config.noteVoidKind}'::text, n.id, n.${config.noteNumberColumn}, n.void_journal_entry_id
      FROM ${config.noteTable} n
     WHERE n.org_id = $1 AND n.${config.partyColumn} = $2 AND n.void_journal_entry_id IS NOT NULL
  ),
  party_rows AS (
    SELECT pe.kind, pe.document_id, pe.document_number,
           e.id AS entry_id, e.entry_date, e.created_at,
           SUM(l.base_debit_cents)  AS debit_cents,
           SUM(l.base_credit_cents) AS credit_cents
      FROM party_entries pe
      JOIN journal_entries e ON e.id = pe.entry_id AND e.org_id = $1
      JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = $1 AND l.account_id = $3
     GROUP BY pe.kind, pe.document_id, pe.document_number, e.id, e.entry_date, e.created_at
  )`;
}

interface SumsRow {
  total_count: string;
  debit_cents: string;
  credit_cents: string;
}

interface PartyRow {
  kind: PartyLedgerEntryKind;
  document_id: string;
  document_number: string | null;
  entry_id: string;
  entry_date: string;
  debit_cents: string;
  credit_cents: string;
  running_signed_cents: string;
}

interface AllocationRow {
  payment_id: string;
  document_id: string;
  document_number: string | null;
  base_amount_cents: string;
}

async function ledger(
  orgId: string,
  partyId: string,
  kind: PartyKind,
  options: PartyLedgerOptions,
): Promise<PartyLedger> {
  const config = PARTY_CONFIG[kind];
  const party = await loadParty(orgId, partyId, kind);

  const controlIds = await resolveControlAccounts(orgId);
  const controlId = kind === 'CUSTOMER' ? controlIds.receivableAccountId : controlIds.payableAccountId;

  const empty: PartyLedger = {
    party,
    controlAccount: null,
    from: options.from,
    to: options.to,
    openingBalanceCents: 0,
    periodDebitCents: 0,
    periodCreditCents: 0,
    closingBalanceCents: 0,
    totalCount: 0,
    rows: [],
  };
  if (controlId === null) return empty;

  const { rows: accountRows } = await pool.query<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM accounts WHERE org_id = $1 AND id = $2',
    [orgId, controlId],
  );
  const controlAccount = accountRows[0];
  if (controlAccount === undefined) return empty;

  const direction = config.debitNormal ? 1 : -1;
  const cte = buildPartyRowsCte(config);

  // Opening balance: everything strictly before `from`; 0 when `from` is null.
  let openingBalanceCents = 0;
  if (options.from !== null) {
    const { rows } = await pool.query<SumsRow>(
      `WITH ${cte}
       SELECT count(*)::text                          AS total_count,
              COALESCE(SUM(debit_cents), 0)::text     AS debit_cents,
              COALESCE(SUM(credit_cents), 0)::text    AS credit_cents
         FROM party_rows
        WHERE entry_date < $4::date`,
      [orgId, partyId, controlAccount.id, options.from],
    );
    const row = rows[0];
    openingBalanceCents =
      direction * (parseCents(row?.debit_cents ?? '0') - parseCents(row?.credit_cents ?? '0'));
  }

  const { rows: periodRows } = await pool.query<SumsRow>(
    `WITH ${cte}
     SELECT count(*)::text                        AS total_count,
            COALESCE(SUM(debit_cents), 0)::text   AS debit_cents,
            COALESCE(SUM(credit_cents), 0)::text  AS credit_cents
       FROM party_rows
      WHERE ($4::date IS NULL OR entry_date >= $4::date)
        AND ($5::date IS NULL OR entry_date <= $5::date)`,
    [orgId, partyId, controlAccount.id, options.from, options.to],
  );
  const periodRow = periodRows[0];
  const totalCount = Number(periodRow?.total_count ?? '0');
  const periodDebitCents = parseCents(periodRow?.debit_cents ?? '0');
  const periodCreditCents = parseCents(periodRow?.credit_cents ?? '0');
  const closingBalanceCents =
    openingBalanceCents + direction * (periodDebitCents - periodCreditCents);

  // Running balance as a window over the whole filtered set, evaluated before
  // LIMIT/OFFSET so page 2 continues page 1 — the same explicit ROWS frame and
  // unambiguous ORDER BY as accountLedgerService.accountLedger.
  const offset = (options.page - 1) * options.limit;
  const { rows: pageRows } = await pool.query<PartyRow>(
    `WITH ${cte}
     SELECT kind, document_id, document_number, entry_id, entry_date,
            debit_cents::text  AS debit_cents,
            credit_cents::text AS credit_cents,
            (SUM(debit_cents - credit_cents)
               OVER (ORDER BY entry_date ASC, created_at ASC, entry_id ASC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::text AS running_signed_cents
       FROM party_rows
      WHERE ($4::date IS NULL OR entry_date >= $4::date)
        AND ($5::date IS NULL OR entry_date <= $5::date)
      ORDER BY entry_date ASC, created_at ASC, entry_id ASC
      LIMIT $6 OFFSET $7`,
    [orgId, partyId, controlAccount.id, options.from, options.to, options.limit, offset],
  );

  // Which documents each payment on this page settled — one query for the
  // page, never one per row.
  const paymentIds = [
    ...new Set(
      pageRows
        .filter((r) => r.kind === 'PAYMENT' || r.kind === 'PAYMENT_VOID')
        .map((r) => r.document_id),
    ),
  ];
  const allocationsByPayment = new Map<string, PartyLedgerAllocation[]>();
  if (paymentIds.length > 0) {
    const { rows: allocationRows } = await pool.query<AllocationRow>(
      `SELECT a.payment_id,
              d.id AS document_id,
              d.${config.numberColumn} AS document_number,
              a.base_amount_cents::text AS base_amount_cents
         FROM payment_allocations a
         JOIN ${config.docTable} d ON d.id = a.${config.allocationColumn} AND d.org_id = a.org_id
        WHERE a.org_id = $1
          AND a.payment_id = ANY($2::uuid[])
        ORDER BY d.${config.numberColumn} ASC NULLS LAST, d.id ASC`,
      [orgId, paymentIds],
    );
    for (const row of allocationRows) {
      const list = allocationsByPayment.get(row.payment_id) ?? [];
      list.push({
        documentId: row.document_id,
        documentNumber: row.document_number,
        baseAmountCents: parseCents(row.base_amount_cents),
      });
      allocationsByPayment.set(row.payment_id, list);
    }
  }

  const rows: PartyLedgerRow[] = pageRows.map((row) => ({
    journalEntryId: row.entry_id,
    entryDate: row.entry_date,
    kind: row.kind,
    documentId: row.document_id,
    documentNumber: row.document_number,
    debitCents: parseCents(row.debit_cents),
    creditCents: parseCents(row.credit_cents),
    runningBalanceCents: openingBalanceCents + direction * parseCents(row.running_signed_cents),
    allocations:
      row.kind === 'PAYMENT' || row.kind === 'PAYMENT_VOID'
        ? (allocationsByPayment.get(row.document_id) ?? [])
        : [],
  }));

  return {
    party,
    controlAccount: { id: controlAccount.id, code: controlAccount.code, name: controlAccount.name },
    from: options.from,
    to: options.to,
    openingBalanceCents,
    periodDebitCents,
    periodCreditCents,
    closingBalanceCents,
    totalCount,
    rows,
  };
}

interface OpenItemRow {
  document_kind: string;
  id: string;
  document_number: string | null;
  document_date: string;
  due_date: string;
  currency_code: string;
  total_cents: string;
  base_total_cents: string;
  outstanding_cents: string;
  days_overdue: number;
  bucket: string;
}

function isAgingBucket(value: string): value is AgingBucket {
  return (AGING_BUCKETS as readonly string[]).includes(value);
}

function isOpenItemKind(value: string): value is PartyOpenItem['documentKind'] {
  return value === 'INVOICE' || value === 'BILL' || value === 'CREDIT_NOTE' || value === 'DEBIT_NOTE';
}

/**
 * The party's open documents. The same bucketing as
 * `agingService.buildOpenDocsCte`, plus the party predicate — copied rather
 * than exported so the aging report's SQL stays its own. `$1` org, `$2` asOf,
 * `$3` party.
 *
 * Phase 26: an ISSUED note's unapplied remainder is an open item too, with a
 * NEGATIVE outstanding (credit the party holds against us / we hold against
 * the vendor). It is never overdue — always CURRENT — and it is what keeps
 * "ledger closing = open-items outstanding" true once a note is issued
 * against an already-settled document.
 */
async function openItems(
  orgId: string,
  partyId: string,
  kind: PartyKind,
  asOf: string | null,
): Promise<PartyOpenItems> {
  const config = PARTY_CONFIG[kind];
  const party = await loadParty(orgId, partyId, kind);
  const on = asOf ?? new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query<OpenItemRow>(
    `WITH open_docs AS (
       SELECT '${config.docKind}'::text AS document_kind,
              d.id,
              d.${config.numberColumn} AS document_number,
              d.${config.dateColumn}   AS document_date,
              d.due_date,
              d.currency_code,
              d.total_cents::text      AS total_cents,
              d.base_total_cents::text AS base_total_cents,
              (d.base_total_cents - ${settledCentsSubquery('d', config.allocationColumn, 'base_amount_cents')}::bigint) AS outstanding_cents,
              GREATEST(0, $2::date - d.due_date) AS days_overdue,
              CASE
                WHEN d.due_date >= $2::date THEN 'CURRENT'
                WHEN d.due_date >  $2::date - INTERVAL '30 days' THEN 'D1_30'
                WHEN d.due_date >  $2::date - INTERVAL '60 days' THEN 'D31_60'
                WHEN d.due_date >  $2::date - INTERVAL '90 days' THEN 'D61_90'
                ELSE 'D90_PLUS'
              END AS bucket
         FROM ${config.docTable} d
        WHERE d.org_id = $1
          AND d.${config.partyColumn} = $3
          AND d.status = '${config.openStatus}'
       UNION ALL
       SELECT '${config.noteKind}'::text,
              n.id,
              n.${config.noteNumberColumn},
              n.issue_date,
              n.issue_date,
              n.currency_code,
              n.total_cents::text,
              n.base_total_cents::text,
              -(n.base_total_cents - ${noteOwnAppliedCentsSubquery('n', config.noteSubqueryKind, 'base_amount_cents')}::bigint),
              0,
              'CURRENT'
         FROM ${config.noteTable} n
        WHERE n.org_id = $1
          AND n.${config.partyColumn} = $3
          AND n.status = 'ISSUED'
     )
     SELECT document_kind, id, document_number, document_date, due_date, currency_code, total_cents,
            base_total_cents, outstanding_cents::text AS outstanding_cents, days_overdue, bucket
       FROM open_docs
      WHERE outstanding_cents <> 0
      ORDER BY due_date ASC, id ASC`,
    [orgId, on, partyId],
  );

  let outstandingCents = 0;
  let overdueCents = 0;
  const items: PartyOpenItem[] = rows.map((row) => {
    if (!isAgingBucket(row.bucket)) {
      throw new Error(`Unknown aging bucket "${row.bucket}" on document ${row.id}`);
    }
    if (!isOpenItemKind(row.document_kind)) {
      throw new Error(`Unknown open item kind "${row.document_kind}" on document ${row.id}`);
    }
    const baseOutstandingCents = parseCents(row.outstanding_cents);
    outstandingCents += baseOutstandingCents;
    if (row.bucket !== 'CURRENT') overdueCents += baseOutstandingCents;
    return {
      documentKind: row.document_kind,
      documentId: row.id,
      documentNumber: row.document_number,
      documentDate: row.document_date,
      dueDate: row.due_date,
      currencyCode: row.currency_code,
      totalCents: parseCents(row.total_cents),
      baseTotalCents: parseCents(row.base_total_cents),
      baseOutstandingCents,
      daysOverdue: Number(row.days_overdue),
      bucket: row.bucket,
    };
  });

  return { party, asOf: on, outstandingCents, overdueCents, items };
}

export async function customerLedger(
  orgId: string,
  customerId: string,
  options: PartyLedgerOptions,
): Promise<PartyLedger> {
  return ledger(orgId, customerId, 'CUSTOMER', options);
}

export async function vendorLedger(
  orgId: string,
  vendorId: string,
  options: PartyLedgerOptions,
): Promise<PartyLedger> {
  return ledger(orgId, vendorId, 'VENDOR', options);
}

export async function customerOpenItems(
  orgId: string,
  customerId: string,
  asOf: string | null,
): Promise<PartyOpenItems> {
  return openItems(orgId, customerId, 'CUSTOMER', asOf);
}

export async function vendorOpenItems(
  orgId: string,
  vendorId: string,
  asOf: string | null,
): Promise<PartyOpenItems> {
  return openItems(orgId, vendorId, 'VENDOR', asOf);
}
