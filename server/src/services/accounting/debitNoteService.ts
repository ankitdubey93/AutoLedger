import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, scaleCents, sumCents } from '../../utils/money.js';
import { convertToBase } from '../../utils/fxRate.js';
import * as journalService from './journalService.js';
import * as billService from './billService.js';
import { resolveApPostingAccountsOnClient } from './settingsService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import { settledCentsOnClient } from './settlementSql.js';
import {
  canTransitionNote,
  isNoteReasonCode,
  isNoteStatus,
  type DebitNote,
  type DebitNoteAllocation,
  type DebitNoteLine,
  type NoteReasonCode,
  type NoteStatus,
} from '../../types/accounting.js';

/**
 * Accounting debit notes — Phase 26's AP correcting document, the
 * purchase-side mirror of `creditNoteService`.
 *
 * A debit note is issued by us to a vendor and reduces what we owe on a
 * POSTED bill: goods returned to the vendor, an overcharge, a short delivery.
 * (The vendor typically answers with their own credit note, whose number is
 * recorded as `vendor_credit_reference`.) Issuing it posts DR Accounts
 * Payable / CR expense (or asset) + CR input tax, and — in the same
 * transaction — applies it to its own bill up to the amount still due. Any
 * remainder is unapplied credit on the vendor's account, which
 * `applyDebitNote` can later match against another open bill.
 *
 * The note always references its original bill and copies that bill's vendor,
 * currency and frozen fx_rate, so applying it back to that bill is FX-neutral.
 *
 * A DRAFT is an ordinary editable row; an ISSUED note is immutable in the
 * database too (migration 063's trg_debit_notes_immutable). Its only
 * correction path is `voidDebitNote`, which posts a reversal.
 *
 * Every GL posting goes through `journalService`'s `*OnClient` functions on
 * this service's own checked-out transaction client (guardrails rules 5 and
 * 16). Lock order is always note first, then bill; payments lock only bills,
 * so the two can never deadlock against each other.
 */

const PG_RAISE_EXCEPTION = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) return undefined;
  return typeof err.constraint === 'string' ? err.constraint : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return typeof err.message === 'string' ? err.message : 'Database rejected the debit note';
  }
  return 'Database rejected the debit note';
}

export interface DebitNoteLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  expenseAccountId: string;
  taxRateBp: number;
}

export interface CreateDebitNoteInput {
  billId: string;
  issueDate: string;
  reasonCode: NoteReasonCode;
  reason: string | null;
  /** The vendor's own credit-note number, when they send one back. */
  vendorCreditReference: string | null;
  notes: string | null;
  lines: DebitNoteLineInput[];
}

export type UpdateDebitNoteInput = CreateDebitNoteInput;

export interface ListDebitNotesOptions {
  page: number;
  limit: number;
  status: NoteStatus | null;
  vendorId: string | null;
  billId: string | null;
  from: string | null;
  to: string | null;
}

export interface ApplyDebitNoteInput {
  billId: string;
  amountCents: number;
  allocationDate: string;
}

// ---------------------------------------------------------------- row mapping

interface DebitNoteRow {
  id: string;
  debit_note_number: string | null;
  status: string;
  vendor_id: string;
  vendor_name: string;
  bill_id: string;
  bill_vendor_reference: string;
  vendor_credit_reference: string | null;
  issue_date: string;
  currency_code: string;
  fx_rate: string;
  reason_code: string;
  reason: string | null;
  vendor_name_snapshot: string;
  vendor_address_snapshot: string | null;
  vendor_tax_number_snapshot: string | null;
  notes: string | null;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  base_subtotal_cents: string;
  base_tax_cents: string;
  base_total_cents: string;
  journal_entry_id: string | null;
  void_journal_entry_id: string | null;
  issued_at: Date | null;
  voided_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DebitNoteLineRow {
  id: string;
  debit_note_id: string;
  line_number: number;
  description: string;
  quantity_milli: string;
  unit_price_cents: string;
  expense_account_id: string;
  expense_account_code: string;
  expense_account_name: string;
  tax_rate_bp: number;
  net_cents: string;
  tax_cents: string;
}

interface AllocationRow {
  id: string;
  debit_note_id: string;
  bill_id: string;
  bill_vendor_reference: string;
  amount_cents: string;
  base_amount_cents: string;
  allocation_date: string;
  created_at: Date;
}

const DEBIT_NOTE_SELECT = `SELECT n.id, n.debit_note_number, n.status, n.vendor_id, c.name AS vendor_name,
                                   n.bill_id, inv.vendor_reference AS bill_vendor_reference, n.vendor_credit_reference, n.issue_date, n.currency_code,
                                   n.fx_rate::text AS fx_rate, n.reason_code, n.reason,
                                   n.vendor_name_snapshot, n.vendor_address_snapshot,
                                   n.vendor_tax_number_snapshot, n.notes,
                                   n.subtotal_cents, n.tax_cents, n.total_cents,
                                   n.base_subtotal_cents, n.base_tax_cents, n.base_total_cents,
                                   n.journal_entry_id, n.void_journal_entry_id, n.issued_at, n.voided_at,
                                   n.created_by, u.name AS created_by_name, n.created_at, n.updated_at
                              FROM debit_notes n
                              JOIN vendors c    ON c.id = n.vendor_id AND c.org_id = n.org_id
                              JOIN bills inv    ON inv.id = n.bill_id AND inv.org_id = n.org_id
                              LEFT JOIN users u ON u.id = n.created_by`;

function toLine(row: DebitNoteLineRow): DebitNoteLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    description: row.description,
    quantityMilli: Number(row.quantity_milli),
    unitPriceCents: parseCents(row.unit_price_cents),
    expenseAccountId: row.expense_account_id,
    expenseAccountCode: row.expense_account_code,
    expenseAccountName: row.expense_account_name,
    taxRateBp: row.tax_rate_bp,
    netCents: parseCents(row.net_cents),
    taxCents: parseCents(row.tax_cents),
  };
}

function toAllocation(row: AllocationRow): DebitNoteAllocation {
  return {
    id: row.id,
    billId: row.bill_id,
    billVendorReference: row.bill_vendor_reference,
    amountCents: parseCents(row.amount_cents),
    baseAmountCents: parseCents(row.base_amount_cents),
    allocationDate: row.allocation_date,
    createdAt: row.created_at.toISOString(),
  };
}

function toDebitNote(
  row: DebitNoteRow,
  lines: DebitNoteLine[],
  allocations: DebitNoteAllocation[],
): DebitNote {
  if (!isNoteStatus(row.status)) {
    throw new Error(`Unknown debit note status "${row.status}" on debit note ${row.id}`);
  }
  if (!isNoteReasonCode(row.reason_code)) {
    throw new Error(`Unknown reason code "${row.reason_code}" on debit note ${row.id}`);
  }

  const totalCents = parseCents(row.total_cents);
  const isOpen = row.status === 'ISSUED';
  const appliedCents = isOpen ? sumCents(allocations.map((a) => cents(a.amountCents))) : 0;

  return {
    id: row.id,
    debitNoteNumber: row.debit_note_number,
    status: row.status,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    billId: row.bill_id,
    billVendorReference: row.bill_vendor_reference,
    vendorCreditReference: row.vendor_credit_reference,
    issueDate: row.issue_date,
    currencyCode: row.currency_code.trim(),
    fxRate: row.fx_rate,
    reasonCode: row.reason_code,
    reason: row.reason,
    vendorNameSnapshot: row.vendor_name_snapshot,
    vendorAddressSnapshot: row.vendor_address_snapshot,
    vendorTaxNumberSnapshot: row.vendor_tax_number_snapshot,
    notes: row.notes,
    subtotalCents: parseCents(row.subtotal_cents),
    taxCents: parseCents(row.tax_cents),
    totalCents,
    baseSubtotalCents: parseCents(row.base_subtotal_cents),
    baseTaxCents: parseCents(row.base_tax_cents),
    baseTotalCents: parseCents(row.base_total_cents),
    journalEntryId: row.journal_entry_id,
    voidJournalEntryId: row.void_journal_entry_id,
    issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lines,
    allocations,
    appliedCents,
    unappliedCents: isOpen ? totalCents - appliedCents : 0,
  };
}

/** Lines and allocations for a set of notes — two queries per page, never one per note. */
async function loadChildren(
  orgId: string,
  noteIds: string[],
): Promise<{ lines: Map<string, DebitNoteLine[]>; allocations: Map<string, DebitNoteAllocation[]> }> {
  const lines = new Map<string, DebitNoteLine[]>();
  const allocations = new Map<string, DebitNoteAllocation[]>();
  if (noteIds.length === 0) return { lines, allocations };

  const { rows: lineRows } = await pool.query<DebitNoteLineRow>(
    `SELECT l.id, l.debit_note_id, l.line_number, l.description, l.quantity_milli, l.unit_price_cents,
            l.expense_account_id, a.code AS expense_account_code, a.name AS expense_account_name,
            l.tax_rate_bp, l.net_cents, l.tax_cents
       FROM debit_note_lines l
       JOIN accounts a ON a.id = l.expense_account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.debit_note_id = ANY($2::uuid[])
      ORDER BY l.line_number ASC`,
    [orgId, noteIds],
  );
  for (const row of lineRows) {
    const list = lines.get(row.debit_note_id) ?? [];
    list.push(toLine(row));
    lines.set(row.debit_note_id, list);
  }

  const { rows: allocationRows } = await pool.query<AllocationRow>(
    `SELECT a.id, a.debit_note_id, a.bill_id, i.vendor_reference AS bill_vendor_reference, a.amount_cents, a.base_amount_cents,
            a.allocation_date, a.created_at
       FROM debit_note_allocations a
       JOIN bills i ON i.id = a.bill_id AND i.org_id = a.org_id
      WHERE a.org_id = $1
        AND a.debit_note_id = ANY($2::uuid[])
      ORDER BY a.allocation_date ASC, a.created_at ASC, a.id ASC`,
    [orgId, noteIds],
  );
  for (const row of allocationRows) {
    const list = allocations.get(row.debit_note_id) ?? [];
    list.push(toAllocation(row));
    allocations.set(row.debit_note_id, list);
  }

  return { lines, allocations };
}

// ---------------------------------------------------------------------- reads

export async function getDebitNoteById(orgId: string, id: string): Promise<DebitNote> {
  const { rows } = await pool.query<DebitNoteRow>(
    `${DEBIT_NOTE_SELECT} WHERE n.id = $1 AND n.org_id = $2`,
    [id, orgId],
  );

  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Debit note not found');

  const { lines, allocations } = await loadChildren(orgId, [row.id]);
  return toDebitNote(row, lines.get(row.id) ?? [], allocations.get(row.id) ?? []);
}

/** One shared `WHERE` for the count and the page query, like billService.buildFilters. */
function buildFilters(
  orgId: string,
  options: ListDebitNotesOptions,
): { where: string; values: unknown[] } {
  const clauses = ['n.org_id = $1'];
  const values: unknown[] = [orgId];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  if (options.status !== null) add((p) => `n.status = ${p}`, options.status);
  if (options.vendorId !== null) add((p) => `n.vendor_id = ${p}::uuid`, options.vendorId);
  if (options.billId !== null) add((p) => `n.bill_id = ${p}::uuid`, options.billId);
  if (options.from !== null) add((p) => `n.issue_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `n.issue_date <= ${p}::date`, options.to);

  return { where: clauses.join(' AND '), values };
}

export async function listDebitNotes(
  orgId: string,
  options: ListDebitNotesOptions,
): Promise<{ debitNotes: DebitNote[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const { where, values } = buildFilters(orgId, options);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM debit_notes n WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `n.id DESC` is the required tiebreaker so pages never swap rows.
  const { rows } = await pool.query<DebitNoteRow>(
    `${DEBIT_NOTE_SELECT}
      WHERE ${where}
      ORDER BY n.issue_date DESC, n.created_at DESC, n.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  const { lines, allocations } = await loadChildren(
    orgId,
    rows.map((r) => r.id),
  );

  return {
    debitNotes: rows.map((row) =>
      toDebitNote(row, lines.get(row.id) ?? [], allocations.get(row.id) ?? []),
    ),
    totalCount,
  };
}

// --------------------------------------------------------------------- writes

interface LineTotal {
  input: DebitNoteLineInput;
  netCents: number;
  taxCents: number;
}

/** Per-line tax, then summed — the same rounding discipline as bills. */
function computeLineTotals(lines: DebitNoteLineInput[]): LineTotal[] {
  return lines.map((line) => {
    const netCents = scaleCents(cents(line.unitPriceCents), line.quantityMilli, 1000);
    const taxCents = scaleCents(netCents, line.taxRateBp, 10000);
    return { input: line, netCents, taxCents };
  });
}

function totalsOf(totals: LineTotal[]): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;
  if (totalCents <= 0) {
    throw new ApiError(422, 'A debit note total must be greater than zero');
  }
  return { subtotalCents, taxCents, totalCents };
}

interface LockedBill {
  id: string;
  status: string;
  vendor_id: string;
  bill_date: string;
  vendor_reference: string;
  currency_code: string;
  fx_rate: string;
  total_cents: string;
  vendor_name_snapshot: string;
  vendor_address_snapshot: string | null;
  vendor_tax_number_snapshot: string | null;
}

async function lockBill(client: PoolClient, orgId: string, billId: string): Promise<LockedBill> {
  const { rows } = await client.query<LockedBill>(
    `SELECT id, status, vendor_id, bill_date, vendor_reference, currency_code, fx_rate::text AS fx_rate, total_cents,
            vendor_name_snapshot, vendor_address_snapshot, vendor_tax_number_snapshot
       FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [billId, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(422, 'Bill not found');
  return row;
}

async function baseCurrencyOf(client: PoolClient, orgId: string): Promise<string> {
  const { rows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = rows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
  return baseCurrency;
}

/**
 * The two caps, checked with the bill already locked FOR UPDATE:
 *   - every ISSUED debit note against this bill, plus this one, may not
 *     exceed the bill total (migration 063's deferred trigger is the
 *     database backstop);
 *   - a foreign-currency note may not exceed what is still due, so it is
 *     always fully applied to its own bill and never leaves a remainder
 *     that would need cross-rate application.
 */
async function assertWithinCaps(
  client: PoolClient,
  orgId: string,
  bill: LockedBill,
  totalCents: number,
  excludeNoteId: string | null,
): Promise<void> {
  const { rows } = await client.query<{ issued: string }>(
    `SELECT COALESCE(SUM(total_cents), 0)::text AS issued
       FROM debit_notes
      WHERE org_id = $1 AND bill_id = $2 AND status = 'ISSUED'
        AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [orgId, bill.id, excludeNoteId],
  );
  const billTotal = parseCents(bill.total_cents);
  if (parseCents(rows[0]?.issued ?? '0') + totalCents > billTotal) {
    throw new ApiError(422, 'Debit notes against this bill would exceed the bill total');
  }

  const baseCurrency = await baseCurrencyOf(client, orgId);
  if (bill.currency_code.trim() !== baseCurrency) {
    const settled = await settledCentsOnClient(client, orgId, 'bill_id', bill.id);
    const dueCents = billTotal - settled.paidCents - settled.noteAppliedCents;
    if (totalCents > dueCents) {
      throw new ApiError(422, 'A foreign-currency debit note cannot exceed the amount still due on its bill');
    }
  }
}

function assertDebitable(bill: LockedBill, issueDate: string): void {
  if (bill.status !== 'POSTED') {
    throw new ApiError(422, 'Only an approved bill can be debited');
  }
  if (issueDate < bill.bill_date) {
    throw new ApiError(422, 'A debit note cannot be dated before its bill');
  }
}

async function insertLines(
  client: PoolClient,
  orgId: string,
  noteId: string,
  totals: LineTotal[],
): Promise<void> {
  await client.query(
    `INSERT INTO debit_note_lines
       (org_id, debit_note_id, line_number, description, quantity_milli, unit_price_cents,
        expense_account_id, tax_rate_bp, net_cents, tax_cents)
     SELECT $1, $2, v.line_number, v.description, v.quantity_milli, v.unit_price_cents,
            v.expense_account_id, v.tax_rate_bp, v.net_cents, v.tax_cents
       FROM unnest(
              $3::smallint[], $4::text[], $5::bigint[], $6::bigint[],
              $7::uuid[], $8::int[], $9::bigint[], $10::bigint[]
            ) AS v(line_number, description, quantity_milli, unit_price_cents,
                    expense_account_id, tax_rate_bp, net_cents, tax_cents)`,
    [
      orgId,
      noteId,
      totals.map((_, i) => i + 1),
      totals.map((t) => t.input.description),
      totals.map((t) => t.input.quantityMilli),
      totals.map((t) => t.input.unitPriceCents),
      totals.map((t) => t.input.expenseAccountId),
      totals.map((t) => t.input.taxRateBp),
      totals.map((t) => t.netCents),
      totals.map((t) => t.taxCents),
    ],
  );
}

function mapWriteError(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
    return new ApiError(422, 'A referenced account does not exist in this organization');
  }
  if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
    return new ApiError(422, pgErrorMessage(err));
  }
  return err;
}

export async function createDebitNote(
  orgId: string,
  createdBy: string,
  input: CreateDebitNoteInput,
): Promise<DebitNote> {
  const totals = computeLineTotals(input.lines);
  const { subtotalCents, taxCents, totalCents } = totalsOf(totals);

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const bill = await lockBill(client, orgId, input.billId);
    assertDebitable(bill, input.issueDate);
    await billService.assertExpenseAccounts(
      client,
      orgId,
      totals.map((t) => t.input.expenseAccountId),
    );
    await assertWithinCaps(client, orgId, bill, totalCents, null);

    const fxRate = bill.fx_rate;
    const baseSubtotalCents = convertToBase(cents(subtotalCents), fxRate);
    const baseTaxCents = convertToBase(cents(taxCents), fxRate);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO debit_notes
         (org_id, vendor_id, bill_id, reason_code, reason, vendor_credit_reference, issue_date, currency_code, fx_rate,
          vendor_name_snapshot, vendor_address_snapshot, vendor_tax_number_snapshot, notes,
          subtotal_cents, tax_cents, total_cents, base_subtotal_cents, base_tax_cents, base_total_cents,
          created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id`,
      [
        orgId,
        bill.vendor_id,
        bill.id,
        input.reasonCode,
        input.reason,
        input.vendorCreditReference,
        input.issueDate,
        bill.currency_code.trim(),
        fxRate,
        bill.vendor_name_snapshot,
        bill.vendor_address_snapshot,
        bill.vendor_tax_number_snapshot,
        input.notes,
        subtotalCents,
        taxCents,
        totalCents,
        baseSubtotalCents,
        baseTaxCents,
        baseSubtotalCents + baseTaxCents,
        createdBy,
      ],
    );
    const noteId = rows[0]?.id;
    if (noteId === undefined) throw new Error('INSERT ... RETURNING produced no row');

    await insertLines(client, orgId, noteId, totals);

    await client.query('COMMIT');
    return await getDebitNoteById(orgId, noteId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw mapWriteError(err);
  } finally {
    client.release();
  }
}

/** A draft edit replaces the whole document, like `updateBill`. */
export async function updateDebitNote(
  orgId: string,
  id: string,
  input: UpdateDebitNoteInput,
): Promise<DebitNote> {
  const totals = computeLineTotals(input.lines);
  const { subtotalCents, taxCents, totalCents } = totalsOf(totals);

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: noteRows } = await client.query<{ status: string; bill_id: string }>(
      'SELECT status, bill_id FROM debit_notes WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const note = noteRows[0];
    if (note === undefined) throw new ApiError(404, 'Debit note not found');
    if (note.status !== 'DRAFT') {
      throw new ApiError(409, 'Only a draft debit note can be edited');
    }
    if (note.bill_id !== input.billId) {
      throw new ApiError(422, 'A draft debit note cannot be moved to a different bill');
    }

    const bill = await lockBill(client, orgId, input.billId);
    assertDebitable(bill, input.issueDate);
    await billService.assertExpenseAccounts(
      client,
      orgId,
      totals.map((t) => t.input.expenseAccountId),
    );
    await assertWithinCaps(client, orgId, bill, totalCents, id);

    const baseSubtotalCents = convertToBase(cents(subtotalCents), bill.fx_rate);
    const baseTaxCents = convertToBase(cents(taxCents), bill.fx_rate);

    await client.query('DELETE FROM debit_note_lines WHERE debit_note_id = $1 AND org_id = $2', [
      id,
      orgId,
    ]);

    await client.query(
      `UPDATE debit_notes
          SET reason_code = $1, reason = $2, issue_date = $3, notes = $4,
              subtotal_cents = $5, tax_cents = $6, total_cents = $7,
              base_subtotal_cents = $8, base_tax_cents = $9, base_total_cents = $10,
              vendor_credit_reference = $13
        WHERE id = $11 AND org_id = $12`,
      [
        input.reasonCode,
        input.reason,
        input.issueDate,
        input.notes,
        subtotalCents,
        taxCents,
        totalCents,
        baseSubtotalCents,
        baseTaxCents,
        baseSubtotalCents + baseTaxCents,
        id,
        orgId,
        input.vendorCreditReference,
      ],
    );

    await insertLines(client, orgId, id, totals);

    await client.query('COMMIT');
    return await getDebitNoteById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw mapWriteError(err);
  } finally {
    client.release();
  }
}

export async function deleteDebitNote(orgId: string, id: string): Promise<void> {
  const { rows } = await withTransaction((client) =>
    client.query<{ id: string }>(
      `DELETE FROM debit_notes WHERE id = $1 AND org_id = $2 AND status = 'DRAFT' RETURNING id`,
      [id, orgId],
    ),
  );

  if (rows[0] !== undefined) return;

  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM debit_notes WHERE id = $1 AND org_id = $2',
    [id, orgId],
  );
  if (existing[0] === undefined) throw new ApiError(404, 'Debit note not found');
  throw new ApiError(409, 'Only a draft debit note can be deleted');
}

// ------------------------------------------------------- issue, void, apply

interface LockedNoteRow {
  id: string;
  status: string;
  bill_id: string;
  vendor_id: string;
  issue_date: string;
  currency_code: string;
  fx_rate: string;
  vendor_name_snapshot: string;
  total_cents: string;
  tax_cents: string;
  journal_entry_id: string | null;
}

type LockedNote = Omit<LockedNoteRow, 'status'> & { status: NoteStatus };

async function lockNote(client: PoolClient, orgId: string, id: string): Promise<LockedNote> {
  const { rows } = await client.query<LockedNoteRow>(
    `SELECT id, status, bill_id, vendor_id, issue_date, currency_code, fx_rate::text AS fx_rate,
            vendor_name_snapshot, total_cents, tax_cents, journal_entry_id
       FROM debit_notes WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [id, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Debit note not found');
  if (!isNoteStatus(row.status)) {
    throw new Error(`Unknown debit note status "${row.status}" on debit note ${id}`);
  }
  return { ...row, status: row.status };
}

export async function issueDebitNote(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<DebitNote> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const note = await lockNote(client, orgId, id);
    const status = note.status;
    if (!canTransitionNote(status, 'ISSUED')) {
      throw new ApiError(409, `A debit note that is ${status} cannot be issued`);
    }

    const bill = await lockBill(client, orgId, note.bill_id);
    if (bill.status !== 'POSTED') {
      throw new ApiError(422, 'Only an approved bill can be debited');
    }
    const totalCents = parseCents(note.total_cents);
    await assertWithinCaps(client, orgId, bill, totalCents, id);

    const { rows: lineRows } = await client.query<{ expense_account_id: string; net_cents: string }>(
      'SELECT expense_account_id, net_cents FROM debit_note_lines WHERE debit_note_id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (lineRows.length === 0) {
      throw new ApiError(422, 'A debit note needs at least one line before it can be issued');
    }

    const taxTotalCents = parseCents(note.tax_cents);
    const currencyCode = note.currency_code.trim();
    const fxRate = note.fx_rate;

    const { payableAccountId, taxAccountId } = await resolveApPostingAccountsOnClient(
      client,
      orgId,
      taxTotalCents > 0,
    );

    // The mirror of approveBillOnClient: a single debit to the payable for the
    // full note total, one credit per distinct expense account (two lines on
    // the same account merge), and a credit for the input tax no longer
    // recoverable.
    const expenseByAccount = new Map<string, number>();
    for (const line of lineRows) {
      const net = parseCents(line.net_cents);
      expenseByAccount.set(
        line.expense_account_id,
        (expenseByAccount.get(line.expense_account_id) ?? 0) + net,
      );
    }

    const glLines = [
      { accountId: payableAccountId, debitCents: totalCents, creditCents: 0, currencyCode, fxRate },
      ...[...expenseByAccount.entries()].map(([accountId, netCents]) => ({
        accountId,
        debitCents: 0,
        creditCents: netCents,
        currencyCode,
        fxRate,
      })),
    ];
    if (taxAccountId !== null && taxTotalCents > 0) {
      glLines.push({ accountId: taxAccountId, debitCents: 0, creditCents: taxTotalCents, currencyCode, fxRate });
    }

    const debitTotal = sumCents(glLines.map((l) => cents(l.debitCents)));
    const creditTotal = sumCents(glLines.map((l) => cents(l.creditCents)));
    if (debitTotal !== creditTotal) {
      // A bug, not user input — chk_debit_notes_total makes this impossible.
      throw new Error('Debit note posting is unbalanced');
    }

    const number = await invoiceSettingsService.allocateNoteNumber(client, orgId, 'DEBIT_NOTE');

    const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
      entryDate: entryDate ?? note.issue_date,
      description: `Debit note ${number} — ${note.vendor_name_snapshot} (against ${bill.vendor_reference})`,
      sourceType: 'debit_note',
      sourceId: id,
      lines: glLines,
    });

    await client.query(
      `UPDATE debit_notes
          SET status = 'ISSUED', debit_note_number = $1, journal_entry_id = $2, issued_at = now()
        WHERE id = $3 AND org_id = $4`,
      [number, journalEntryId, id, orgId],
    );

    // Auto-apply to the original bill, up to what it still owes. A fully
    // paid bill takes nothing — the whole note stays as unapplied credit
    // on the vendor's account.
    const settled = await settledCentsOnClient(client, orgId, 'bill_id', bill.id);
    const dueCents = parseCents(bill.total_cents) - settled.paidCents - settled.noteAppliedCents;
    const applyCents = Math.min(totalCents, dueCents);
    if (applyCents > 0) {
      await client.query(
        `INSERT INTO debit_note_allocations
           (org_id, debit_note_id, bill_id, amount_cents, base_amount_cents, allocation_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, id, bill.id, applyCents, convertToBase(cents(applyCents), fxRate), note.issue_date, userId],
      );
    }

    // COMMIT runs the deferred cap and allocation-limit triggers.
    await client.query('COMMIT');
    return await getDebitNoteById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_debit_notes_org_number') {
      throw new ApiError(409, 'Debit note number already exists — try again');
    }
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function voidDebitNote(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<DebitNote> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const note = await lockNote(client, orgId, id);
    const status = note.status;
    if (!canTransitionNote(status, 'VOID')) {
      throw new ApiError(409, 'This debit note has already been voided');
    }

    if (status === 'ISSUED') {
      if (note.journal_entry_id === null) {
        throw new Error(`Issued debit note ${id} has no journal_entry_id`);
      }
      const reversalId = await journalService.reverseEntryOnClient(
        client,
        orgId,
        userId,
        note.journal_entry_id,
        entryDate,
      );
      // Allocations are not touched — they are insert-only and stop counting
      // toward settlement the moment the note leaves ISSUED, which re-opens
      // every bill the note was applied to.
      await client.query(
        `UPDATE debit_notes SET status = 'VOID', voided_at = now(), void_journal_entry_id = $1
          WHERE id = $2 AND org_id = $3`,
        [reversalId, id, orgId],
      );
    } else {
      // A draft posted nothing, so there is nothing to reverse.
      await client.query(
        `UPDATE debit_notes SET status = 'VOID', voided_at = now() WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
    }

    await client.query('COMMIT');
    return await getDebitNoteById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies unapplied credit to an open bill of the same vendor.
 *
 * Posts NO journal entry, on purpose: the note already debited Accounts
 * Payable and the bill already credited it, so both are sitting inside the
 * one AP control balance. Applying one to the other is subledger matching
 * — it changes which open items the vendor's account shows, not the GL.
 */
export async function applyDebitNote(
  orgId: string,
  userId: string,
  id: string,
  input: ApplyDebitNoteInput,
): Promise<DebitNote> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const note = await lockNote(client, orgId, id);
    if (note.status !== 'ISSUED') {
      throw new ApiError(409, 'Only an issued debit note can be applied');
    }

    const baseCurrency = await baseCurrencyOf(client, orgId);
    const currencyCode = note.currency_code.trim();
    if (currencyCode !== baseCurrency && input.billId !== note.bill_id) {
      throw new ApiError(422, 'A foreign-currency debit note can only be applied to its original bill');
    }

    const bill = await lockBill(client, orgId, input.billId);
    if (bill.vendor_id !== note.vendor_id) {
      throw new ApiError(422, 'That bill belongs to a different vendor');
    }
    if (bill.status !== 'POSTED') {
      throw new ApiError(422, 'Only an approved bill can have a debit applied');
    }
    if (bill.currency_code.trim() !== currencyCode) {
      throw new ApiError(422, 'A debit note can only be applied to a bill in the same currency');
    }
    if (input.allocationDate < note.issue_date || input.allocationDate < bill.bill_date) {
      throw new ApiError(422, 'A debit cannot be applied before the debit note or the bill is dated');
    }

    const { rows: appliedRows } = await client.query<{ applied: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS applied
         FROM debit_note_allocations WHERE org_id = $1 AND debit_note_id = $2`,
      [orgId, id],
    );
    const unappliedCents = parseCents(note.total_cents) - parseCents(appliedRows[0]?.applied ?? '0');
    if (input.amountCents > unappliedCents) {
      throw new ApiError(422, 'Amount exceeds the credit still available on this debit note');
    }

    const settled = await settledCentsOnClient(client, orgId, 'bill_id', bill.id);
    const dueCents = parseCents(bill.total_cents) - settled.paidCents - settled.noteAppliedCents;
    if (input.amountCents > dueCents) {
      throw new ApiError(422, 'Amount exceeds the amount still due on this bill');
    }

    await client.query(
      `INSERT INTO debit_note_allocations
         (org_id, debit_note_id, bill_id, amount_cents, base_amount_cents, allocation_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        orgId,
        id,
        bill.id,
        input.amountCents,
        convertToBase(cents(input.amountCents), note.fx_rate),
        input.allocationDate,
        userId,
      ],
    );

    await client.query('COMMIT');
    return await getDebitNoteById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}
