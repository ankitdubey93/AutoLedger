import { pool } from '../../db/connect.js';
import { allocateCents, cents } from '../../utils/money.js';

export type DocumentDirection = 'SALES' | 'PURCHASES';

export interface DocumentLineEvent {
  documentKind: 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'DEBIT_NOTE';
  documentId: string;
  documentNumber: string | null;
  /** +1 for an invoice/bill posting or a note's void; −1 for a document void or a note posting. */
  sign: 1 | -1;
  entryDate: string;
  partyId: string;
  partyName: string;
  lineId: string;
  itemId: string | null;
  taxRateBp: number;
  quantityMilli: number; // signed by `sign`
  baseNetCents: number; // signed by `sign`
  baseTaxCents: number; // signed by `sign`
}

interface BranchSpec {
  documentKind: DocumentLineEvent['documentKind'];
  doc: string;
  lines: string;
  fk: string;
  party: string;
  partyFk: string;
  number: string;
  journalColumn: 'journal_entry_id' | 'void_journal_entry_id';
  sign: 1 | -1;
  hasItem: boolean;
  standardOnly: boolean;
}

// Every identifier below is a compile-time constant (rule 4); only values are parameters.
function spec(
  documentKind: BranchSpec['documentKind'],
  doc: string,
  lines: string,
  fk: string,
  party: string,
  partyFk: string,
  number: string,
  hasItem: boolean,
  standardOnly: boolean,
): BranchSpec[] {
  const isNote = documentKind === 'CREDIT_NOTE' || documentKind === 'DEBIT_NOTE';
  const postSign: 1 | -1 = isNote ? -1 : 1;
  const base = { documentKind, doc, lines, fk, party, partyFk, number, hasItem, standardOnly };
  return [
    { ...base, journalColumn: 'journal_entry_id', sign: postSign },
    { ...base, journalColumn: 'void_journal_entry_id', sign: postSign === 1 ? -1 : 1 },
  ];
}

const BRANCHES: Record<DocumentDirection, BranchSpec[]> = {
  SALES: [
    ...spec('INVOICE', 'invoices', 'invoice_lines', 'invoice_id', 'customers', 'customer_id', 'invoice_number', true, true),
    ...spec('CREDIT_NOTE', 'credit_notes', 'credit_note_lines', 'credit_note_id', 'customers', 'customer_id', 'credit_note_number', false, false),
  ],
  PURCHASES: [
    ...spec('BILL', 'bills', 'bill_lines', 'bill_id', 'vendors', 'vendor_id', 'vendor_reference', true, true),
    ...spec('DEBIT_NOTE', 'debit_notes', 'debit_note_lines', 'debit_note_id', 'vendors', 'vendor_id', 'debit_note_number', false, false),
  ],
};

function branchSql(b: BranchSpec, branchIndex: number): string {
  return `
    SELECT
      ${branchIndex}::int AS branch,
      d.id AS document_id,
      d.${b.number} AS document_number,
      to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
      p.id AS party_id,
      p.name AS party_name,
      d.base_subtotal_cents::text AS base_subtotal,
      d.base_tax_cents::text AS base_tax,
      l.id AS line_id,
      ${b.hasItem ? 'l.item_id' : 'NULL::uuid'} AS item_id,
      l.tax_rate_bp,
      l.quantity_milli::text AS quantity_milli,
      l.net_cents::text AS net_cents,
      l.tax_cents::text AS tax_cents,
      l.line_number
    FROM ${b.doc} d
    JOIN journal_entries e ON e.id = d.${b.journalColumn} AND e.org_id = d.org_id
    JOIN ${b.party} p ON p.id = d.${b.partyFk} AND p.org_id = d.org_id
    JOIN ${b.lines} l ON l.${b.fk} = d.id AND l.org_id = d.org_id
    WHERE d.org_id = $1
      AND e.org_id = $1
      AND e.entry_date BETWEEN $2 AND $3
      ${b.standardOnly ? "AND d.kind = 'STANDARD'" : ''}`;
}

interface Row {
  branch: number;
  document_id: string;
  document_number: string | null;
  entry_date: string;
  party_id: string;
  party_name: string;
  base_subtotal: string;
  base_tax: string;
  line_id: string;
  item_id: string | null;
  tax_rate_bp: number;
  quantity_milli: string;
  net_cents: string;
  tax_cents: string;
  line_number: number;
}

function shares(documentId: string, total: number, weights: number[]): number[] {
  if (weights.every((w) => w === 0)) {
    if (total === 0) return weights.map(() => 0);
    throw new Error(`Document ${documentId}: base total ${total} across zero-weight lines`);
  }
  return allocateCents(cents(total), weights.map((w) => cents(w)));
}

/** Every line of every STANDARD document whose posting or void entry is dated in [from, to]. */
export async function loadDocumentLineEvents(
  orgId: string,
  direction: DocumentDirection,
  from: string,
  to: string,
): Promise<DocumentLineEvent[]> {
  const branches = BRANCHES[direction];
  const sql = `${branches.map((b, i) => branchSql(b, i)).join('\nUNION ALL\n')}
    ORDER BY entry_date, document_id, line_number`;
  const { rows } = await pool.query<Row>(sql, [orgId, from, to]);

  // Group rows into events: (branch, document) is one (documentKind, documentId, sign) event.
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.branch}:${row.document_id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const events: DocumentLineEvent[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const b = branches[first.branch];
    if (!b) continue;
    const netShares = shares(first.document_id, Number(first.base_subtotal), group.map((r) => Number(r.net_cents)));
    const taxShares = shares(first.document_id, Number(first.base_tax), group.map((r) => Number(r.tax_cents)));
    group.forEach((r, i) => {
      events.push({
        documentKind: b.documentKind,
        documentId: r.document_id,
        documentNumber: r.document_number,
        sign: b.sign,
        entryDate: r.entry_date,
        partyId: r.party_id,
        partyName: r.party_name,
        lineId: r.line_id,
        itemId: r.item_id,
        taxRateBp: r.tax_rate_bp,
        quantityMilli: b.sign * Number(r.quantity_milli),
        baseNetCents: b.sign * (netShares[i] ?? 0),
        baseTaxCents: b.sign * (taxShares[i] ?? 0),
      });
    });
  }

  events.sort((x, y) =>
    x.entryDate < y.entryDate ? -1 : x.entryDate > y.entryDate ? 1 :
    x.documentId < y.documentId ? -1 : x.documentId > y.documentId ? 1 : 0,
  );
  return events;
}
