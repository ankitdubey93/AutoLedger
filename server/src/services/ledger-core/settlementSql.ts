import type { PoolClient } from 'pg';
import { parseCents } from '../../utils/money.js';

/**
 * The one definition of "how much of a document is settled" (Phase 26).
 *
 * A document — an invoice or a bill — is settled by two things: POSTED
 * payment allocations (Phase 3.9) and ISSUED credit/debit note allocations
 * (Phase 26). Settlement is never stored; every "amount due" in the codebase
 * is `total − settledCentsSubquery(...)`, derived on every read, so voiding a
 * payment or a note un-settles its documents for free (the allocation rows
 * stay, immutably, and stop counting once their parent leaves POSTED/ISSUED).
 *
 * This module imports no service on purpose — `paymentService`,
 * `invoiceService`, `billService` and the reports all import it, so it must
 * sit below every one of them to stay free of import cycles.
 *
 * Every function here returns SQL text built by interpolation. That is safe
 * only because `alias`, `column`, `amountColumn` and `kind` are closed unions
 * or compile-time constants supplied by our own code, never request input —
 * the identifier-whitelisting allowance in guardrails rule 4. Every fragment
 * correlates on `${alias}.org_id` (rule 1).
 */

export type SettlementColumn = 'invoice_id' | 'bill_id';
export type SettlementAmountColumn = 'amount_cents' | 'base_amount_cents';

/**
 * Sums POSTED payment allocations against one document. A correlated scalar
 * subquery, not a JOIN + GROUP BY: the outer query (invoiceService's
 * INVOICE_SELECT, billService's BILL_SELECT) is one row per document, and a
 * join would fan it out.
 *
 * `p.status = 'POSTED'` is what makes voiding a payment un-settle its
 * documents for free. Removing it silently makes voided payments settle
 * invoices.
 *
 * `amountColumn` defaults to the native amount; `agingService` and
 * `partyLedgerService` pass 'base_amount_cents' to reconcile against a
 * base-currency GL control balance. Moved here verbatim from paymentService
 * in Phase 26, which re-exports it.
 */
export function allocatedCentsSubquery(
  alias: string,
  column: SettlementColumn,
  amountColumn: SettlementAmountColumn = 'amount_cents',
): string {
  return `COALESCE((SELECT SUM(pa.${amountColumn})
                      FROM payment_allocations pa
                      JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
                     WHERE pa.org_id = ${alias}.org_id
                       AND pa.${column} = ${alias}.id
                       AND p.status = 'POSTED'), 0)::text`;
}

const NOTE_SOURCES = {
  invoice_id: { allocations: 'credit_note_allocations', notes: 'credit_notes', noteColumn: 'credit_note_id' },
  bill_id: { allocations: 'debit_note_allocations', notes: 'debit_notes', noteColumn: 'debit_note_id' },
} as const;

/**
 * Sums ISSUED note allocations against one document — credit notes for an
 * invoice, debit notes for a bill. `n.status = 'ISSUED'` plays the same role
 * as the payment subquery's `p.status = 'POSTED'`.
 */
export function noteAppliedCentsSubquery(
  alias: string,
  column: SettlementColumn,
  amountColumn: SettlementAmountColumn = 'amount_cents',
): string {
  const source = NOTE_SOURCES[column];
  return `COALESCE((SELECT SUM(na.${amountColumn})
                      FROM ${source.allocations} na
                      JOIN ${source.notes} n ON n.id = na.${source.noteColumn} AND n.org_id = na.org_id
                     WHERE na.org_id = ${alias}.org_id
                       AND na.${column} = ${alias}.id
                       AND n.status = 'ISSUED'), 0)::text`;
}

/** Payments + applied notes — what every amount-due computation subtracts from a document's total. */
export function settledCentsSubquery(
  alias: string,
  column: SettlementColumn,
  amountColumn: SettlementAmountColumn = 'amount_cents',
): string {
  return `(${allocatedCentsSubquery(alias, column, amountColumn)}::bigint + ${noteAppliedCentsSubquery(alias, column, amountColumn)}::bigint)::text`;
}

const NOTE_OWN = {
  credit: { allocations: 'credit_note_allocations', noteColumn: 'credit_note_id' },
  debit: { allocations: 'debit_note_allocations', noteColumn: 'debit_note_id' },
} as const;

/**
 * How much of a note itself has been applied, to any document. `alias` is
 * the note row's own alias. No status filter: the caller only asks this of an
 * ISSUED note.
 */
export function noteOwnAppliedCentsSubquery(
  alias: string,
  kind: 'credit' | 'debit',
  amountColumn: SettlementAmountColumn = 'amount_cents',
): string {
  const source = NOTE_OWN[kind];
  return `COALESCE((SELECT SUM(oa.${amountColumn})
                      FROM ${source.allocations} oa
                     WHERE oa.org_id = ${alias}.org_id
                       AND oa.${source.noteColumn} = ${alias}.id), 0)::text`;
}

/**
 * One document's settled amounts, read on the caller's transaction client —
 * for code that already holds a FOR UPDATE lock on the document (payments,
 * note issue/apply). Never `pool.query` here: that would read outside the
 * caller's transaction (guardrails rule 5).
 */
export async function settledCentsOnClient(
  client: PoolClient,
  orgId: string,
  column: SettlementColumn,
  documentId: string,
): Promise<{ paidCents: number; noteAppliedCents: number }> {
  const source = NOTE_SOURCES[column];

  const { rows: paidRows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(pa.amount_cents), 0)::text AS total
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
      WHERE pa.org_id = $1 AND pa.${column} = $2 AND p.status = 'POSTED'`,
    [orgId, documentId],
  );

  const { rows: noteRows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(na.amount_cents), 0)::text AS total
       FROM ${source.allocations} na
       JOIN ${source.notes} n ON n.id = na.${source.noteColumn} AND n.org_id = na.org_id
      WHERE na.org_id = $1 AND na.${column} = $2 AND n.status = 'ISSUED'`,
    [orgId, documentId],
  );

  return {
    paidCents: parseCents(paidRows[0]?.total ?? '0'),
    noteAppliedCents: parseCents(noteRows[0]?.total ?? '0'),
  };
}
