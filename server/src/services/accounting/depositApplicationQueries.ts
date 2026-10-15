import type { PoolClient } from 'pg';
import type { DepositApplication, QuoteDirection } from '../../types/accounting.js';
import { parseCents } from '../../utils/money.js';

/**
 * Phase 42 — the read side of `deposit_applications`, kept in its own module
 * so `invoiceService` and `billService` (which show a document's applications
 * and refuse to void a document that has a POSTED one) can import it without
 * importing `depositService`, which imports them.
 */

type Queryable = Pick<PoolClient, 'query'>;

/** Identifiers only ever come from this constant map (rule 4). */
const DOCUMENT = {
  SALES: {
    deposit: 'deposit_invoice_id',
    target: 'target_invoice_id',
    table: 'invoices',
    number: 'invoice_number',
  },
  PURCHASE: {
    deposit: 'deposit_bill_id',
    target: 'target_bill_id',
    table: 'bills',
    number: 'vendor_reference',
  },
} as const;

const DIRECTION_OF_KIND = { invoice: 'SALES', bill: 'PURCHASE' } as const;

export interface DepositApplicationRow {
  id: string;
  direction: QuoteDirection;
  deposit_document_id: string;
  deposit_document_number: string | null;
  target_document_id: string;
  target_document_number: string | null;
  amount_cents: string;
  application_date: string;
  status: 'POSTED' | 'VOID';
  journal_entry_id: string;
  void_journal_entry_id: string | null;
  created_at: Date;
}

export function toDepositApplication(row: DepositApplicationRow): DepositApplication {
  return {
    id: row.id,
    direction: row.direction,
    depositDocumentId: row.deposit_document_id,
    depositDocumentNumber: row.deposit_document_number,
    targetDocumentId: row.target_document_id,
    targetDocumentNumber: row.target_document_number,
    amountCents: parseCents(row.amount_cents),
    applicationDate: row.application_date,
    status: row.status,
    journalEntryId: row.journal_entry_id,
    voidJournalEntryId: row.void_journal_entry_id,
    createdAt: row.created_at.toISOString(),
  };
}

/** The SELECT list + joins for one direction; callers append their own WHERE. */
export function depositApplicationSelect(direction: QuoteDirection): string {
  const d = DOCUMENT[direction];
  return `SELECT da.id, da.direction,
                 da.${d.deposit} AS deposit_document_id, dd.${d.number} AS deposit_document_number,
                 da.${d.target} AS target_document_id, td.${d.number} AS target_document_number,
                 da.amount_cents::text AS amount_cents, da.application_date::text AS application_date,
                 da.status, da.journal_entry_id, da.void_journal_entry_id, da.created_at
            FROM deposit_applications da
            JOIN ${d.table} dd ON dd.id = da.${d.deposit} AND dd.org_id = da.org_id
            JOIN ${d.table} td ON td.id = da.${d.target} AND td.org_id = da.org_id`;
}

/** Applications in which this document is the deposit or the target, newest first (rule 1: org-scoped). */
export async function listDepositApplicationsForDocument(
  q: Queryable,
  orgId: string,
  direction: QuoteDirection,
  documentId: string,
): Promise<DepositApplication[]> {
  const d = DOCUMENT[direction];
  const { rows } = await q.query<DepositApplicationRow>(
    `${depositApplicationSelect(direction)}
      WHERE da.org_id = $1 AND da.direction = $2 AND (da.${d.deposit} = $3 OR da.${d.target} = $3)
      ORDER BY da.created_at DESC, da.id`,
    [orgId, direction, documentId],
  );
  return rows.map(toDepositApplication);
}

/** True when a POSTED application uses this document as its deposit or its target. */
export async function hasPostedDepositApplicationsOnClient(
  client: Queryable,
  orgId: string,
  kind: 'invoice' | 'bill',
  documentId: string,
): Promise<boolean> {
  const d = DOCUMENT[DIRECTION_OF_KIND[kind]];
  const { rows } = await client.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deposit_applications da
        WHERE da.org_id = $1 AND da.status = 'POSTED' AND (da.${d.deposit} = $2 OR da.${d.target} = $2)
     ) AS found`,
    [orgId, documentId],
  );
  return rows[0]?.found === true;
}
