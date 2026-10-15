import type { PoolClient } from 'pg';
import { parseCents } from '../../utils/money.js';

/**
 * The one definition of "how much of a document is settled" (Phase 26).
 *
 * A document — an invoice or a bill — is settled by three things: POSTED
 * payment allocations (Phase 3.9), ISSUED credit/debit note allocations
 * (Phase 26) and POSTED deposit applications (Phase 42). Settlement is never stored; every "amount due" in the codebase
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

const DEPOSIT_TARGET_COLUMN = {
  invoice_id: 'target_invoice_id',
  bill_id: 'target_bill_id',
} as const;

/**
 * Sums POSTED deposit applications against one target document (Phase 42) —
 * the third settlement source. `da.status = 'POSTED'` plays the same role as
 * the payment subquery's `p.status = 'POSTED'`: voiding an application
 * un-settles its target for free.
 */
export function depositAppliedCentsSubquery(
  alias: string,
  column: SettlementColumn,
  amountColumn: SettlementAmountColumn = 'amount_cents',
): string {
  const targetColumn = DEPOSIT_TARGET_COLUMN[column];
  return `COALESCE((SELECT SUM(da.${amountColumn})
                      FROM deposit_applications da
                     WHERE da.org_id = ${alias}.org_id
                       AND da.${targetColumn} = ${alias}.id
                       AND da.status = 'POSTED'), 0)::text`;
}

/** Payments + applied notes + applied deposits — what every amount-due computation subtracts from a document's total. */
export function settledCentsSubquery(
  alias: string,
  column: SettlementColumn,
  amountColumn: SettlementAmountColumn = 'amount_cents',
): string {
  return `(${allocatedCentsSubquery(alias, column, amountColumn)}::bigint + ${noteAppliedCentsSubquery(alias, column, amountColumn)}::bigint + ${depositAppliedCentsSubquery(alias, column, amountColumn)}::bigint)::text`;
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
): Promise<{ paidCents: number; noteAppliedCents: number; depositAppliedCents: number }> {
  const source = NOTE_SOURCES[column];
  const depositColumn = DEPOSIT_TARGET_COLUMN[column];

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

  const { rows: depositRows } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(da.amount_cents), 0)::text AS total
       FROM deposit_applications da
      WHERE da.org_id = $1 AND da.${depositColumn} = $2 AND da.status = 'POSTED'`,
    [orgId, documentId],
  );

  return {
    paidCents: parseCents(paidRows[0]?.total ?? '0'),
    noteAppliedCents: parseCents(noteRows[0]?.total ?? '0'),
    depositAppliedCents: parseCents(depositRows[0]?.total ?? '0'),
  };
}

// ---------------------------------------------------------------- Phase 39 — as-at settlement

/**
 * A positional SQL parameter, e.g. `'$2'`. Typed as a template literal so a
 * caller cannot pass anything but a placeholder into the fragments below —
 * the same rule-4 reasoning as `alias`/`column`.
 */
export type SqlParam = `$${number}`;

/**
 * POSTED-at-the-date payment allocations against one document (Phase 39).
 *
 * The "now" subqueries above read a payment's *current* status. An as-at
 * statement must instead ask what was true on `asOf`: the payment's journal
 * entry was dated on or before it, and it had not yet been voided — i.e. it
 * has no void journal entry, or that entry is dated after `asOf`. Both dates
 * are the journal entries' `entry_date`, the same date the party ledger
 * (`partyLedgerService.ledger`) filters on, which is what keeps
 * Σ as-at open items equal to the ledger's closing balance at `asOf`.
 */
export function allocatedAsOfCentsSubquery(
  alias: string,
  column: SettlementColumn,
  amountColumn: SettlementAmountColumn,
  asOf: SqlParam,
): string {
  return `COALESCE((SELECT SUM(pa.${amountColumn})
                      FROM payment_allocations pa
                      JOIN payments p         ON p.id = pa.payment_id AND p.org_id = pa.org_id
                      JOIN journal_entries pe ON pe.id = p.journal_entry_id AND pe.org_id = p.org_id
                 LEFT JOIN journal_entries pv ON pv.id = p.void_journal_entry_id AND pv.org_id = p.org_id
                     WHERE pa.org_id = ${alias}.org_id
                       AND pa.${column} = ${alias}.id
                       AND pe.entry_date <= ${asOf}::date
                       AND (pv.id IS NULL OR pv.entry_date > ${asOf}::date)), 0)::text`;
}

/**
 * Note allocations applied on or before `asOf` (by their own
 * `allocation_date` — a note allocation posts no journal entry) whose note
 * was not yet voided at that date.
 */
export function noteAppliedAsOfCentsSubquery(
  alias: string,
  column: SettlementColumn,
  amountColumn: SettlementAmountColumn,
  asOf: SqlParam,
): string {
  const source = NOTE_SOURCES[column];
  return `COALESCE((SELECT SUM(na.${amountColumn})
                      FROM ${source.allocations} na
                      JOIN ${source.notes} n       ON n.id = na.${source.noteColumn} AND n.org_id = na.org_id
                 LEFT JOIN journal_entries nv      ON nv.id = n.void_journal_entry_id AND nv.org_id = n.org_id
                     WHERE na.org_id = ${alias}.org_id
                       AND na.${column} = ${alias}.id
                       AND na.allocation_date <= ${asOf}::date
                       AND (nv.id IS NULL OR nv.entry_date > ${asOf}::date)), 0)::text`;
}

/**
 * Deposit applications applied on or before `asOf` (by `application_date`) and
 * not yet voided at that date. A void's date is its void journal entry's
 * `entry_date`, as for notes and payments (`voided_at` is a wall-clock
 * timestamp and would disagree with the ledger for a back-dated void).
 */
export function depositAppliedAsOfCentsSubquery(
  alias: string,
  column: SettlementColumn,
  asOf: SqlParam,
  amountColumn: SettlementAmountColumn = 'amount_cents',
): string {
  const targetColumn = DEPOSIT_TARGET_COLUMN[column];
  return `COALESCE((SELECT SUM(da.${amountColumn})
                      FROM deposit_applications da
                 LEFT JOIN journal_entries dv ON dv.id = da.void_journal_entry_id AND dv.org_id = da.org_id
                     WHERE da.org_id = ${alias}.org_id
                       AND da.${targetColumn} = ${alias}.id
                       AND da.application_date <= ${asOf}::date
                       AND (dv.id IS NULL OR dv.entry_date > ${asOf}::date)), 0)::text`;
}

/** Payments + applied notes + applied deposits, as they stood on `asOf`. */
export function settledAsOfCentsSubquery(
  alias: string,
  column: SettlementColumn,
  amountColumn: SettlementAmountColumn,
  asOf: SqlParam,
): string {
  return `(${allocatedAsOfCentsSubquery(alias, column, amountColumn, asOf)}::bigint + ${noteAppliedAsOfCentsSubquery(alias, column, amountColumn, asOf)}::bigint + ${depositAppliedAsOfCentsSubquery(alias, column, asOf, amountColumn)}::bigint)::text`;
}

/**
 * How much of a note itself had been applied by `asOf`. The caller has
 * already established the note was alive (issued, not yet voided) on that
 * date, so only the allocation date matters.
 */
export function noteOwnAppliedAsOfCentsSubquery(
  alias: string,
  kind: 'credit' | 'debit',
  amountColumn: SettlementAmountColumn,
  asOf: SqlParam,
): string {
  const source = NOTE_OWN[kind];
  return `COALESCE((SELECT SUM(oa.${amountColumn})
                      FROM ${source.allocations} oa
                     WHERE oa.org_id = ${alias}.org_id
                       AND oa.${source.noteColumn} = ${alias}.id
                       AND oa.allocation_date <= ${asOf}::date), 0)::text`;
}
