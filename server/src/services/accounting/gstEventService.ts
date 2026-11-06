import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { auTaxCode } from '../../config/taxPacks/au.js';
import type { GstBasis } from '../../config/regions.js';
import { cents, scaleCents } from '../../utils/money.js';
import { loadDocumentLineEvents } from './documentLineEvents.js';
import {
  noteOwnAppliedAsOfCentsSubquery,
  settledAsOfCentsSubquery,
} from './settlementSql.js';

/**
 * Phase 49d — the one stream of GST events behind the BAS, GST audit and TPAR.
 *
 * A signed amount per document line or journal detail, in base currency:
 * positive increases that side of the BAS, negative reduces it. Only codes
 * that are reported on a BAS are returned.
 */
type Queryable = Pick<PoolClient, 'query'>;

export type GstSourceKind = 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'DEBIT_NOTE' | 'JOURNAL';

export interface GstEvent {
  sourceKind: GstSourceKind;
  sourceId: string;
  documentNumber: string | null;
  partyId: string | null;
  partyName: string | null;
  /** The posting date, or the period's end for a cash-basis event that is a sum of several payments. */
  eventDate: string;
  taxCode: string;
  netCents: number;
  taxCents: number;
  priorPeriod: boolean;
}

export interface GstEventResult {
  events: GstEvent[];
  /** Lines posted in the period with no code: from before the organization became Australian. */
  uncodedLineCount: number;
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isReported(code: string): boolean {
  return auTaxCode(code)?.reported === true;
}

async function accrualDocumentEvents(q: Queryable, orgId: string, from: string, to: string): Promise<GstEventResult> {
  // One after the other: `q` may be a single transaction's client.
  const sales = await loadDocumentLineEvents(orgId, 'SALES', from, to, q);
  const purchases = await loadDocumentLineEvents(orgId, 'PURCHASES', from, to, q);
  const events: GstEvent[] = [];
  let uncodedLineCount = 0;
  for (const e of [...sales, ...purchases]) {
    if (e.taxCode === null) {
      uncodedLineCount += 1;
      continue;
    }
    if (!isReported(e.taxCode)) continue;
    events.push({
      sourceKind: e.documentKind,
      sourceId: e.documentId,
      documentNumber: e.documentNumber,
      partyId: e.partyId,
      partyName: e.partyName,
      eventDate: e.entryDate,
      taxCode: e.taxCode,
      netCents: e.baseNetCents,
      taxCents: e.baseTaxCents,
      priorPeriod: e.originalEntryDate !== null && e.originalEntryDate < from,
    });
  }
  return { events, uncodedLineCount };
}

interface CashSpec {
  kind: Exclude<GstSourceKind, 'JOURNAL'>;
  doc: string;
  lines: string;
  fk: string;
  party: string;
  partyFk: string;
  number: string;
  sign: 1 | -1;
  /** SQL for how much of the document had been settled or applied at a parameter. */
  settled: (asOf: `$${number}`) => string;
  standardOnly: boolean;
}

// Every identifier below is a compile-time constant (rule 4); only values are parameters.
const CASH_SPECS: readonly CashSpec[] = [
  {
    kind: 'INVOICE', doc: 'invoices', lines: 'invoice_lines', fk: 'invoice_id', party: 'customers', partyFk: 'customer_id',
    number: 'invoice_number', sign: 1, standardOnly: true,
    settled: (asOf) => settledAsOfCentsSubquery('d', 'invoice_id', 'amount_cents', asOf),
  },
  {
    kind: 'BILL', doc: 'bills', lines: 'bill_lines', fk: 'bill_id', party: 'vendors', partyFk: 'vendor_id',
    number: 'vendor_reference', sign: 1, standardOnly: true,
    settled: (asOf) => settledAsOfCentsSubquery('d', 'bill_id', 'amount_cents', asOf),
  },
  {
    kind: 'CREDIT_NOTE', doc: 'credit_notes', lines: 'credit_note_lines', fk: 'credit_note_id', party: 'customers', partyFk: 'customer_id',
    number: 'credit_note_number', sign: -1, standardOnly: false,
    settled: (asOf) => noteOwnSettled('credit', asOf),
  },
  {
    kind: 'DEBIT_NOTE', doc: 'debit_notes', lines: 'debit_note_lines', fk: 'debit_note_id', party: 'vendors', partyFk: 'vendor_id',
    number: 'debit_note_number', sign: -1, standardOnly: false,
    settled: (asOf) => noteOwnSettled('debit', asOf),
  },
];

/** A note's applied amount at a date, and nothing once it has been voided by then. */
function noteOwnSettled(kind: 'credit' | 'debit', asOf: `$${number}`): string {
  return `(CASE WHEN EXISTS (SELECT 1 FROM journal_entries nv
                              WHERE nv.id = d.void_journal_entry_id AND nv.org_id = d.org_id
                                AND nv.entry_date <= ${asOf}::date)
                THEN '0'
                ELSE ${noteOwnAppliedAsOfCentsSubquery('d', kind, 'amount_cents', asOf)}
           END)`;
}

interface CashDocRow {
  id: string;
  number: string | null;
  party_id: string;
  party_name: string;
  total_cents: string;
  base_subtotal_cents: string;
  base_tax_cents: string;
  settled_to: string;
  settled_before: string;
}

interface CashLineRow {
  document_id: string;
  tax_code: string | null;
  net_cents: string;
  tax_cents: string;
}

export function attributed(amount: number, settled: number, total: number): number {
  const fraction = Math.min(settled, total);
  return Number(scaleCents(cents(amount), fraction, total));
}

/**
 * Cash basis. A document reports the change, over the period, in its cumulative
 * share: line x settled(to) / total - line x settled(before) / total.
 *
 * Cumulative rather than per-payment so that rounding telescopes: once a
 * document is fully settled its periods sum to exactly its tax, however many
 * payments it took. A voided payment needs no special case either, since the
 * as-at helpers stop counting it and the difference comes out negative.
 *
 * A note counts by the amount applied, the same date as the allocation that
 * settles its invoice, so an invoice cleared entirely by a note nets to nil.
 */
async function cashDocumentEvents(q: Queryable, orgId: string, from: string, to: string): Promise<GstEventResult> {
  const before = dayBefore(from);
  const events: GstEvent[] = [];
  let uncodedLineCount = 0;

  for (const spec of CASH_SPECS) {
    const { rows: docs } = await q.query<CashDocRow>(
      `SELECT * FROM (
         SELECT d.id, d.${spec.number} AS number, p.id AS party_id, p.name AS party_name,
                d.total_cents::text AS total_cents,
                d.base_subtotal_cents::text AS base_subtotal_cents,
                d.base_tax_cents::text AS base_tax_cents,
                ${spec.settled('$2')} AS settled_to,
                ${spec.settled('$3')} AS settled_before
           FROM ${spec.doc} d
           JOIN ${spec.party} p ON p.id = d.${spec.partyFk} AND p.org_id = d.org_id
          WHERE d.org_id = $1
            AND d.journal_entry_id IS NOT NULL
            AND d.total_cents > 0
            ${spec.standardOnly ? "AND d.kind = 'STANDARD'" : ''}
       ) x
       WHERE x.settled_to::bigint <> x.settled_before::bigint`,
      [orgId, to, before],
    );
    if (docs.length === 0) continue;

    const { rows: lines } = await q.query<CashLineRow>(
      `SELECT l.${spec.fk} AS document_id, l.tax_code, l.net_cents::text AS net_cents, l.tax_cents::text AS tax_cents
         FROM ${spec.lines} l
        WHERE l.org_id = $1 AND l.${spec.fk} = ANY($2::uuid[])
        ORDER BY l.${spec.fk}, l.line_number`,
      [orgId, docs.map((d) => d.id)],
    );
    const linesByDoc = new Map<string, CashLineRow[]>();
    for (const line of lines) {
      const group = linesByDoc.get(line.document_id);
      if (group) group.push(line);
      else linesByDoc.set(line.document_id, [line]);
    }

    for (const doc of docs) {
      const total = Number(doc.total_cents);
      const settledTo = Number(doc.settled_to);
      const settledBefore = Number(doc.settled_before);
      const group = linesByDoc.get(doc.id) ?? [];
      const nativeNet = group.reduce((sum, l) => sum + Number(l.net_cents), 0);
      const nativeTax = group.reduce((sum, l) => sum + Number(l.tax_cents), 0);
      for (const line of group) {
        if (line.tax_code === null) {
          uncodedLineCount += 1;
          continue;
        }
        if (!isReported(line.tax_code)) continue;
        // Base-currency share of the line, from the document's frozen rate.
        const baseNet = nativeNet === 0 ? 0 : attributed(Number(doc.base_subtotal_cents), Number(line.net_cents), nativeNet);
        const baseTax = nativeTax === 0 ? 0 : attributed(Number(doc.base_tax_cents), Number(line.tax_cents), nativeTax);
        const netCents = attributed(baseNet, settledTo, total) - attributed(baseNet, settledBefore, total);
        const taxCents = attributed(baseTax, settledTo, total) - attributed(baseTax, settledBefore, total);
        if (netCents === 0 && taxCents === 0) continue;
        events.push({
          sourceKind: spec.kind,
          sourceId: doc.id,
          documentNumber: doc.number,
          partyId: doc.party_id,
          partyName: doc.party_name,
          eventDate: to,
          taxCode: line.tax_code,
          netCents: spec.sign * netCents,
          taxCents: spec.sign * taxCents,
          priorPeriod: false,
        });
      }
    }
  }
  return { events, uncodedLineCount };
}

interface JournalRow {
  journal_entry_id: string;
  description: string | null;
  entry_date: string;
  tax_code: string;
  net_cents: string;
  tax_cents: string;
  sign: number;
}

/** Journals report when posted on either basis: the money has already moved, or the entry says so. A reversal mirrors its original. */
async function journalEvents(q: Queryable, orgId: string, from: string, to: string): Promise<GstEvent[]> {
  const { rows } = await q.query<JournalRow>(
    `SELECT e.id AS journal_entry_id, e.description, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
            d.tax_code, d.net_cents::text AS net_cents, d.tax_cents::text AS tax_cents, d.sign::int AS sign
       FROM journal_tax_details d
       JOIN journal_entries e ON e.id = d.journal_entry_id AND e.org_id = d.org_id
      WHERE d.org_id = $1 AND e.entry_date BETWEEN $2 AND $3
     UNION ALL
     SELECT r.id, r.description, to_char(r.entry_date, 'YYYY-MM-DD'),
            d.tax_code, d.net_cents::text, d.tax_cents::text, -d.sign::int
       FROM journal_tax_details d
       JOIN journal_entries r ON r.reverses_entry_id = d.journal_entry_id AND r.org_id = d.org_id
      WHERE d.org_id = $1 AND r.entry_date BETWEEN $2 AND $3
     ORDER BY 3, 1`,
    [orgId, from, to],
  );
  return rows.flatMap((r) =>
    isReported(r.tax_code)
      ? [
          {
            sourceKind: 'JOURNAL' as const,
            sourceId: r.journal_entry_id,
            documentNumber: r.description,
            partyId: null,
            partyName: null,
            eventDate: r.entry_date,
            taxCode: r.tax_code,
            netCents: r.sign * Number(r.net_cents),
            taxCents: r.sign * Number(r.tax_cents),
            priorPeriod: false,
          },
        ]
      : [],
  );
}

export async function loadGstEvents(
  orgId: string,
  from: string,
  to: string,
  basis: GstBasis,
  q: Queryable = pool,
): Promise<GstEventResult> {
  const documents = basis === 'CASH' ? await cashDocumentEvents(q, orgId, from, to) : await accrualDocumentEvents(q, orgId, from, to);
  const journals = await journalEvents(q, orgId, from, to);
  return { events: [...documents.events, ...journals], uncodedLineCount: documents.uncodedLineCount };
}
