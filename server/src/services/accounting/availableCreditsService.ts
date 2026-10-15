import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import type { AvailableCredit, AvailableCredits, QuoteDirection } from '../../types/accounting.js';
import { settledCentsOnClient } from './settlementSql.js';
import { applyDebitNoteOnClient } from './debitNoteService.js';
import { applyCreditNoteOnClient } from './creditNoteService.js';
import { applyDepositOnClient } from './depositService.js';

/**
 * Phase 43c — which open credits could be applied to a draft bill (debit notes
 * and supplier prepayments) or a draft invoice (credit notes and customer
 * deposits) when it is approved/issued. Legality is computed against THIS
 * document, mirroring the checks the apply cores make, so the dialog only
 * offers what the approval would accept. Read-only; every statement is scoped
 * by org_id (rule 1). The cores re-check everything at apply time.
 *
 * Identifiers are interpolated only from the frozen `SIDE` map (rule 4).
 */

const SIDE = {
  SALES: {
    noun: 'Invoice',
    table: 'invoices',
    partyColumn: 'customer_id',
    dateColumn: 'issue_date',
    numberColumn: 'invoice_number',
    editableStatuses: ['DRAFT'],
    openStatus: 'ISSUED',
    lineTable: 'invoice_lines',
    lineFk: 'invoice_id',
    allocationColumn: 'invoice_id',
    noteTable: 'credit_notes',
    noteNumberColumn: 'credit_note_number',
    noteAllocationTable: 'credit_note_allocations',
    noteAllocationFk: 'credit_note_id',
    depositApplicationColumn: 'deposit_invoice_id',
  },
  PURCHASE: {
    noun: 'Bill',
    table: 'bills',
    partyColumn: 'vendor_id',
    dateColumn: 'bill_date',
    numberColumn: 'vendor_reference',
    editableStatuses: ['DRAFT', 'AWAITING_APPROVAL'],
    openStatus: 'POSTED',
    lineTable: 'bill_lines',
    lineFk: 'bill_id',
    allocationColumn: 'bill_id',
    noteTable: 'debit_notes',
    noteNumberColumn: 'debit_note_number',
    noteAllocationTable: 'debit_note_allocations',
    noteAllocationFk: 'debit_note_id',
    depositApplicationColumn: 'deposit_bill_id',
  },
} as const;

export async function listAvailableCredits(
  orgId: string,
  direction: QuoteDirection,
  documentId: string,
): Promise<AvailableCredits> {
  const s = SIDE[direction];

  return withTransaction(async (client) => {
    const { rows: targets } = await client.query<{
      id: string;
      status: string;
      kind: string;
      party_id: string;
      currency_code: string;
    }>(
      `SELECT id, status, kind, ${s.partyColumn} AS party_id, currency_code
         FROM ${s.table}
        WHERE org_id = $1 AND id = $2`,
      [orgId, documentId],
    );
    const target = targets[0];
    if (target === undefined) throw new ApiError(404, `${s.noun} not found`);
    const editable: readonly string[] = s.editableStatuses;
    if (target.kind !== 'STANDARD' || !editable.includes(target.status)) return { credits: [] };

    const currencyCode = target.currency_code.trim();
    const { rows: orgRows } = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const baseCurrency = orgRows[0]?.base_currency.trim();
    if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
    const isBase = currencyCode === baseCurrency;

    const credits: AvailableCredit[] = [];

    // Notes: a foreign-currency note applies only to its own original, which is
    // already posted and so cannot be this draft — base-currency documents only.
    if (isBase) {
      const { rows: notes } = await client.query<{
        id: string;
        number: string | null;
        date: string;
        currency_code: string;
        available: string;
      }>(
        `SELECT n.id, n.${s.noteNumberColumn} AS number, n.issue_date::text AS date, n.currency_code,
                (n.total_cents - COALESCE(SUM(a.amount_cents), 0))::text AS available
           FROM ${s.noteTable} n
           LEFT JOIN ${s.noteAllocationTable} a ON a.org_id = n.org_id AND a.${s.noteAllocationFk} = n.id
          WHERE n.org_id = $1 AND n.${s.partyColumn} = $2 AND n.status = 'ISSUED' AND n.currency_code = $3
          GROUP BY n.id
         HAVING n.total_cents - COALESCE(SUM(a.amount_cents), 0) > 0
          ORDER BY n.issue_date, n.id`,
        [orgId, target.party_id, currencyCode],
      );
      for (const n of notes) {
        credits.push({
          kind: 'NOTE',
          id: n.id,
          number: n.number,
          date: n.date,
          currencyCode: n.currency_code.trim(),
          availableCents: parseCents(n.available),
        });
      }

      // Deposits: base currency, same party, raised for an order this document
      // draws on, and actually received and not yet applied.
      const { rows: deposits } = await client.query<{
        id: string;
        number: string | null;
        date: string;
        currency_code: string;
      }>(
        `SELECT dep.id, dep.${s.numberColumn} AS number, dep.${s.dateColumn}::text AS date, dep.currency_code
           FROM ${s.table} dep
          WHERE dep.org_id = $1 AND dep.${s.partyColumn} = $2 AND dep.kind = 'DEPOSIT'
            AND dep.status = $3 AND dep.currency_code = $4
            AND dep.deposit_for_order_id IN (
              SELECT ol.order_id
                FROM ${s.lineTable} l
                JOIN order_lines ol ON ol.org_id = l.org_id AND ol.id = l.order_line_id
               WHERE l.org_id = $1 AND l.${s.lineFk} = $5)
          ORDER BY dep.${s.dateColumn}, dep.id`,
        [orgId, target.party_id, s.openStatus, currencyCode, target.id],
      );
      for (const dep of deposits) {
        const settled = await settledCentsOnClient(client, orgId, s.allocationColumn, dep.id);
        const { rows: appliedRows } = await client.query<{ applied: string }>(
          `SELECT COALESCE(SUM(amount_cents), 0)::text AS applied
             FROM deposit_applications
            WHERE org_id = $1 AND ${s.depositApplicationColumn} = $2 AND status = 'POSTED'`,
          [orgId, dep.id],
        );
        const availableCents = settled.paidCents - parseCents(appliedRows[0]?.applied ?? '0');
        if (availableCents > 0) {
          credits.push({
            kind: 'DEPOSIT',
            id: dep.id,
            number: dep.number,
            date: dep.date,
            currencyCode: dep.currency_code.trim(),
            availableCents,
          });
        }
      }
    }

    return { credits };
  });
}

export interface ApplyCreditInput {
  kind: 'NOTE' | 'DEPOSIT';
  id: string;
  amountCents: number;
}

/**
 * Applies the chosen credits to a document that has JUST been approved/issued,
 * on the SAME transaction client (Phase 43c) — so a rejected credit rolls the
 * approval back with it. Lock order: the document row (already locked by the
 * caller) -> notes in ascending id -> deposits in ascending id (each deposit
 * application then locks target + deposit by id). Every rule — same party,
 * currency, amount due, amount available — is the apply core's own; this
 * function only orders the calls and picks the allocation date (the later of
 * the document's date and the credit's date, so neither core rejects it as
 * "before dated"). No pool, no transaction of its own (rule 5).
 */
export async function applyCreditsOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  documentId: string,
  credits: readonly ApplyCreditInput[],
): Promise<void> {
  if (credits.length === 0) return;
  const s = SIDE[direction];

  const { rows: docRows } = await client.query<{ document_date: string }>(
    `SELECT ${s.dateColumn}::text AS document_date FROM ${s.table} WHERE org_id = $1 AND id = $2`,
    [orgId, documentId],
  );
  const documentDate = docRows[0]?.document_date;
  if (documentDate === undefined) throw new ApiError(404, `${s.noun} not found`);

  // A credit's own date; an id that is not found simply has none here and the
  // core raises its own not-found.
  const dateOf = new Map<string, string>();
  const noteIds = credits.filter((c) => c.kind === 'NOTE').map((c) => c.id);
  const depositIds = credits.filter((c) => c.kind === 'DEPOSIT').map((c) => c.id);
  if (noteIds.length > 0) {
    const { rows } = await client.query<{ id: string; date: string }>(
      `SELECT id, issue_date::text AS date FROM ${s.noteTable} WHERE org_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, noteIds],
    );
    for (const r of rows) dateOf.set(r.id, r.date);
  }
  if (depositIds.length > 0) {
    const { rows } = await client.query<{ id: string; date: string }>(
      `SELECT id, ${s.dateColumn}::text AS date FROM ${s.table} WHERE org_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, depositIds],
    );
    for (const r of rows) dateOf.set(r.id, r.date);
  }
  const dateFor = (id: string): string => {
    const own = dateOf.get(id);
    return own !== undefined && own > documentDate ? own : documentDate;
  };

  const byId = (a: ApplyCreditInput, b: ApplyCreditInput): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const notes = credits.filter((c) => c.kind === 'NOTE').sort(byId);
  const deposits = credits.filter((c) => c.kind === 'DEPOSIT').sort(byId);

  for (const credit of notes) {
    const allocationDate = dateFor(credit.id);
    if (direction === 'PURCHASE') {
      await applyDebitNoteOnClient(client, orgId, userId, credit.id, {
        billId: documentId,
        amountCents: credit.amountCents,
        allocationDate,
      });
    } else {
      await applyCreditNoteOnClient(client, orgId, userId, credit.id, {
        invoiceId: documentId,
        amountCents: credit.amountCents,
        allocationDate,
      });
    }
  }
  for (const credit of deposits) {
    await applyDepositOnClient(client, orgId, userId, direction, documentId, {
      depositDocumentId: credit.id,
      amountCents: credit.amountCents,
      applicationDate: dateFor(credit.id),
    });
  }
}
