import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, scaleCents, sumCents } from '../../utils/money.js';
import * as journalService from './journalService.js';
import { allocatedCentsSubquery } from './paymentService.js';
import {
  canTransitionBill,
  isBillStatus,
  settlementStatusOf,
  type Bill,
  type BillLine,
  type BillStatus,
} from '../../types/ledger-core.js';

/**
 * LedgerCore bills — Phase 3.9's AP source document.
 *
 * A bill has FOUR lifecycle states, not three like an invoice: entry
 * (DRAFT), review (AWAITING_APPROVAL), posting (POSTED), and correction
 * (VOID). Approval is deliberately gated by a different role than entry
 * (routes/ledger-core/billRoutes.ts) — a segregation-of-duties control, and
 * the reason the review queue exists at all.
 *
 * A DRAFT or AWAITING_APPROVAL bill is an ordinary editable row: it has
 * posted nothing, so `updateBill` and `deleteBill` are legitimate (not a
 * rule 6 violation). Once posted, a bill is immutable in the database as
 * well as in this service — migration 013's `trg_bills_immutable` trigger
 * enforces it independently. The only correction path for a posted bill is
 * `voidBill`, which posts a reversing journal entry, exactly like
 * `invoiceService.voidInvoice` does for a sales invoice.
 *
 * This file never writes `journal_entries` or `ledger_lines` directly —
 * every GL posting goes through `journalService`'s `*OnClient` functions on
 * this service's own checked-out transaction client (guardrails rules 5 and 16).
 */

const PG_RAISE_EXCEPTION = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';

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
    return typeof err.message === 'string' ? err.message : 'Database rejected the bill';
  }
  return 'Database rejected the bill';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface BillLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  expenseAccountId: string;
  taxRateBp: number;
}

export interface CreateBillInput {
  vendorId: string;
  vendorReference: string;
  billDate: string;
  dueDate: string;
  notes: string | null;
  paymentTerms: string | null;
  lines: BillLineInput[];
}

export type UpdateBillInput = CreateBillInput;

export interface ListBillsOptions {
  page: number;
  limit: number;
  status: BillStatus | null;
  vendorId: string | null;
  from: string | null;
  to: string | null;
  q: string | null;
  /** `null` for no filter. OUTSTANDING/OVERDUE/PAID all imply status = POSTED. */
  settlement: 'OUTSTANDING' | 'OVERDUE' | 'PAID' | null;
}

// ---------------------------------------------------------------- row mapping

interface BillRow {
  id: string;
  vendor_reference: string;
  status: string;
  vendor_id: string;
  vendor_name: string;
  bill_date: string;
  due_date: string;
  currency_code: string;
  vendor_name_snapshot: string;
  vendor_address_snapshot: string | null;
  vendor_tax_number_snapshot: string | null;
  notes: string | null;
  payment_terms: string | null;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  journal_entry_id: string | null;
  void_journal_entry_id: string | null;
  submitted_at: Date | null;
  posted_at: Date | null;
  voided_at: Date | null;
  approved_by: string | null;
  approved_by_name: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  allocated_cents: string;
}

interface BillLineRow {
  id: string;
  bill_id: string;
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

const BILL_SELECT = `SELECT b.id, b.vendor_reference, b.status, b.vendor_id, v.name AS vendor_name,
                             b.bill_date, b.due_date, b.currency_code,
                             b.vendor_name_snapshot, b.vendor_address_snapshot,
                             b.vendor_tax_number_snapshot, b.notes, b.payment_terms,
                             b.subtotal_cents, b.tax_cents, b.total_cents,
                             b.journal_entry_id, b.void_journal_entry_id,
                             b.submitted_at, b.posted_at, b.voided_at,
                             b.approved_by, au.name AS approved_by_name,
                             b.created_by, u.name AS created_by_name, b.created_at, b.updated_at,
                             ${allocatedCentsSubquery('b', 'bill_id')} AS allocated_cents
                        FROM bills b
                        JOIN vendors v ON v.id = b.vendor_id AND v.org_id = b.org_id
                        LEFT JOIN users u  ON u.id = b.created_by
                        LEFT JOIN users au ON au.id = b.approved_by`;

function toLine(row: BillLineRow): BillLine {
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

function toBill(row: BillRow, lines: BillLine[]): Bill {
  if (!isBillStatus(row.status)) {
    throw new Error(`Unknown bill status "${row.status}" on bill ${row.id}`);
  }

  const isOpen = row.status === 'POSTED';
  const totalCents = parseCents(row.total_cents);
  const allocatedCents = isOpen ? parseCents(row.allocated_cents) : 0;
  const amountDueCents = isOpen ? totalCents - allocatedCents : 0;
  const settlementStatus = settlementStatusOf({
    isOpen,
    totalCents,
    allocatedCents,
    dueDate: row.due_date,
    asOf: today(),
  });

  return {
    id: row.id,
    vendorReference: row.vendor_reference,
    status: row.status,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    billDate: row.bill_date,
    dueDate: row.due_date,
    currencyCode: row.currency_code.trim(),
    vendorNameSnapshot: row.vendor_name_snapshot,
    vendorAddressSnapshot: row.vendor_address_snapshot,
    vendorTaxNumberSnapshot: row.vendor_tax_number_snapshot,
    notes: row.notes,
    paymentTerms: row.payment_terms,
    subtotalCents: parseCents(row.subtotal_cents),
    taxCents: parseCents(row.tax_cents),
    totalCents,
    journalEntryId: row.journal_entry_id,
    voidJournalEntryId: row.void_journal_entry_id,
    submittedAt: row.submitted_at === null ? null : row.submitted_at.toISOString(),
    postedAt: row.posted_at === null ? null : row.posted_at.toISOString(),
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lines,
    allocatedCents,
    amountDueCents,
    settlementStatus,
  };
}

/** Loads the lines for a set of bills in one query — never one query per bill. */
async function loadLines(orgId: string, billIds: string[]): Promise<Map<string, BillLine[]>> {
  const byBill = new Map<string, BillLine[]>();
  if (billIds.length === 0) return byBill;

  const { rows } = await pool.query<BillLineRow>(
    `SELECT l.id, l.bill_id, l.line_number, l.description, l.quantity_milli, l.unit_price_cents,
            l.expense_account_id, a.code AS expense_account_code, a.name AS expense_account_name,
            l.tax_rate_bp, l.net_cents, l.tax_cents
       FROM bill_lines l
       JOIN accounts a ON a.id = l.expense_account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.bill_id = ANY($2::uuid[])
      ORDER BY l.line_number ASC`,
    [orgId, billIds],
  );

  for (const row of rows) {
    const list = byBill.get(row.bill_id) ?? [];
    list.push(toLine(row));
    byBill.set(row.bill_id, list);
  }
  return byBill;
}

// ---------------------------------------------------------------------- reads

export async function getBillById(orgId: string, id: string): Promise<Bill> {
  const { rows } = await pool.query<BillRow>(`${BILL_SELECT} WHERE b.id = $1 AND b.org_id = $2`, [
    id,
    orgId,
  ]);

  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Bill not found');

  const lines = await loadLines(orgId, [row.id]);
  return toBill(row, lines.get(row.id) ?? []);
}

/**
 * Builds one shared `WHERE` predicate for both the count and the page query,
 * exactly like `invoiceService.buildFilters` — sharing it is what keeps
 * `totalCount` honest under a filter.
 */
function buildFilters(
  orgId: string,
  options: ListBillsOptions,
): { where: string; values: unknown[] } {
  const clauses = ['b.org_id = $1'];
  const values: unknown[] = [orgId];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  if (options.status !== null) add((p) => `b.status = ${p}`, options.status);
  if (options.vendorId !== null) add((p) => `b.vendor_id = ${p}::uuid`, options.vendorId);
  if (options.from !== null) add((p) => `b.bill_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `b.bill_date <= ${p}::date`, options.to);
  // `alias` and `column` below are our own constants, never request input (rule 4).
  if (options.settlement === 'OUTSTANDING') {
    clauses.push(`b.status = 'POSTED' AND b.total_cents > ${allocatedCentsSubquery('b', 'bill_id')}::bigint`);
  } else if (options.settlement === 'OVERDUE') {
    add(
      (p) =>
        `b.status = 'POSTED' AND b.total_cents > ${allocatedCentsSubquery('b', 'bill_id')}::bigint AND b.due_date < ${p}::date`,
      today(),
    );
  } else if (options.settlement === 'PAID') {
    clauses.push(`b.status = 'POSTED' AND b.total_cents <= ${allocatedCentsSubquery('b', 'bill_id')}::bigint`);
  }
  if (options.q !== null)
    add(
      (p) =>
        `(b.vendor_reference ILIKE '%' || ${p} || '%' OR b.vendor_name_snapshot ILIKE '%' || ${p} || '%')`,
      options.q,
    );

  return { where: clauses.join(' AND '), values };
}

export async function listBills(
  orgId: string,
  options: ListBillsOptions,
): Promise<{ bills: Bill[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const { where, values } = buildFilters(orgId, options);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM bills b WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `b.id DESC` is a required tiebreaker: two bills sharing a bill_date and
  // created_at could otherwise swap between pages.
  const { rows } = await pool.query<BillRow>(
    `${BILL_SELECT}
      WHERE ${where}
      ORDER BY b.bill_date DESC, b.created_at DESC, b.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  const lines = await loadLines(
    orgId,
    rows.map((r) => r.id),
  );

  return {
    bills: rows.map((row) => toBill(row, lines.get(row.id) ?? [])),
    totalCount,
  };
}

// --------------------------------------------------------------------- writes

interface ResolvedAccount {
  id: string;
  code: string;
  is_postable: boolean;
  type: string;
}

/** Confirms every expense account exists in this org, is postable, and is type Expense or Asset (plan D8). */
async function assertExpenseAccounts(
  client: PoolClient,
  orgId: string,
  accountIds: string[],
): Promise<void> {
  const unique = [...new Set(accountIds)];

  const { rows } = await client.query<ResolvedAccount>(
    'SELECT id, code, is_postable, type FROM accounts WHERE org_id = $1 AND id = ANY($2::uuid[])',
    [orgId, unique],
  );

  if (rows.length !== unique.length) {
    throw new ApiError(422, 'Expense account not found');
  }
  const header = rows.find((row) => !row.is_postable);
  if (header !== undefined) {
    throw new ApiError(422, `Account ${header.code} is a header account and cannot be posted to`);
  }
  const wrongType = rows.find((row) => row.type !== 'Expense' && row.type !== 'Asset');
  if (wrongType !== undefined) {
    throw new ApiError(422, `Account ${wrongType.code} must be an Expense or Asset account`);
  }
}

interface LineTotal {
  input: BillLineInput;
  netCents: number;
  taxCents: number;
}

/**
 * Tax is computed per line and then summed — never on the subtotal — so a
 * mixed-rate bill is correct and the stored line values reconcile to the
 * header exactly, which `chk_bills_total` asserts.
 */
function computeLineTotals(lines: BillLineInput[]): LineTotal[] {
  return lines.map((line) => {
    const netCents = scaleCents(cents(line.unitPriceCents), line.quantityMilli, 1000);
    const taxCents = scaleCents(netCents, line.taxRateBp, 10000);
    return { input: line, netCents, taxCents };
  });
}

function validateBillInput(input: CreateBillInput): void {
  if (input.lines.length === 0) {
    throw new ApiError(422, 'A bill needs at least one line');
  }
  if (input.dueDate < input.billDate) {
    throw new ApiError(422, 'Due date cannot be before the bill date');
  }
}

async function insertBillLines(
  client: PoolClient,
  orgId: string,
  billId: string,
  totals: LineTotal[],
): Promise<void> {
  await client.query(
    `INSERT INTO bill_lines
       (org_id, bill_id, line_number, description, quantity_milli, unit_price_cents,
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
      billId,
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

export async function createBill(
  orgId: string,
  createdBy: string,
  input: CreateBillInput,
): Promise<Bill> {
  validateBillInput(input);
  const totals = computeLineTotals(input.lines);
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: orgRows } = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const currencyCode = orgRows[0]?.base_currency.trim();
    if (currencyCode === undefined) throw new ApiError(404, 'Organization not found');

    const { rows: vendorRows } = await client.query<{
      name: string;
      billing_address: string | null;
      tax_number: string | null;
    }>(
      'SELECT name, billing_address, tax_number FROM vendors WHERE id = $1 AND org_id = $2 AND is_active = true',
      [input.vendorId, orgId],
    );
    const vendor = vendorRows[0];
    if (vendor === undefined) throw new ApiError(422, 'Vendor not found');

    await assertExpenseAccounts(
      client,
      orgId,
      totals.map((t) => t.input.expenseAccountId),
    );

    const { rows: billRows } = await client.query<{ id: string }>(
      `INSERT INTO bills
         (org_id, vendor_id, vendor_reference, bill_date, due_date, currency_code,
          vendor_name_snapshot, vendor_address_snapshot, vendor_tax_number_snapshot,
          notes, payment_terms, subtotal_cents, tax_cents, total_cents, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        orgId,
        input.vendorId,
        input.vendorReference,
        input.billDate,
        input.dueDate,
        currencyCode,
        vendor.name,
        vendor.billing_address,
        vendor.tax_number,
        input.notes,
        input.paymentTerms,
        subtotalCents,
        taxCents,
        totalCents,
        createdBy,
      ],
    );
    const billId = billRows[0]?.id;
    if (billId === undefined) throw new Error('INSERT ... RETURNING produced no row');

    await insertBillLines(client, orgId, billId, totals);

    await client.query('COMMIT');
    return await getBillById(orgId, billId);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_bills_vendor_reference') {
      throw new ApiError(409, 'This vendor reference has already been entered for this vendor');
    }
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

/** A draft/in-review edit replaces the whole document — the document is small and the client carries no line identity to diff against. */
export async function updateBill(orgId: string, id: string, input: UpdateBillInput): Promise<Bill> {
  validateBillInput(input);
  const totals = computeLineTotals(input.lines);
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: statusRows } = await client.query<{ status: string }>(
      'SELECT status FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const statusRow = statusRows[0];
    if (statusRow === undefined) throw new ApiError(404, 'Bill not found');
    if (statusRow.status !== 'DRAFT' && statusRow.status !== 'AWAITING_APPROVAL') {
      throw new ApiError(409, 'Only a draft or in-review bill can be edited');
    }

    const { rows: vendorRows } = await client.query<{
      name: string;
      billing_address: string | null;
      tax_number: string | null;
    }>(
      'SELECT name, billing_address, tax_number FROM vendors WHERE id = $1 AND org_id = $2 AND is_active = true',
      [input.vendorId, orgId],
    );
    const vendor = vendorRows[0];
    if (vendor === undefined) throw new ApiError(422, 'Vendor not found');

    await assertExpenseAccounts(
      client,
      orgId,
      totals.map((t) => t.input.expenseAccountId),
    );

    await client.query('DELETE FROM bill_lines WHERE bill_id = $1 AND org_id = $2', [id, orgId]);

    await client.query(
      `UPDATE bills
          SET vendor_id = $1, vendor_reference = $2, bill_date = $3, due_date = $4,
              vendor_name_snapshot = $5, vendor_address_snapshot = $6,
              vendor_tax_number_snapshot = $7, notes = $8, payment_terms = $9,
              subtotal_cents = $10, tax_cents = $11, total_cents = $12
        WHERE id = $13 AND org_id = $14`,
      [
        input.vendorId,
        input.vendorReference,
        input.billDate,
        input.dueDate,
        vendor.name,
        vendor.billing_address,
        vendor.tax_number,
        input.notes,
        input.paymentTerms,
        subtotalCents,
        taxCents,
        totalCents,
        id,
        orgId,
      ],
    );

    await insertBillLines(client, orgId, id, totals);

    await client.query('COMMIT');
    return await getBillById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_bills_vendor_reference') {
      throw new ApiError(409, 'This vendor reference has already been entered for this vendor');
    }
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteBill(orgId: string, id: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `DELETE FROM bills
      WHERE id = $1 AND org_id = $2 AND status IN ('DRAFT', 'AWAITING_APPROVAL')
      RETURNING id`,
    [id, orgId],
  );

  if (rows[0] !== undefined) return;

  // No row deleted: distinguish "does not exist" from "exists but not editable".
  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM bills WHERE id = $1 AND org_id = $2',
    [id, orgId],
  );
  if (existing[0] === undefined) throw new ApiError(404, 'Bill not found');
  throw new ApiError(409, 'Only a draft or in-review bill can be deleted');
}

export async function submitBill(orgId: string, id: string): Promise<Bill> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Bill not found');
    if (!isBillStatus(row.status)) {
      throw new Error(`Unknown bill status "${row.status}" on bill ${id}`);
    }
    if (!canTransitionBill(row.status, 'AWAITING_APPROVAL')) {
      throw new ApiError(409, 'This bill is already awaiting approval');
    }

    await client.query(
      `UPDATE bills SET status = 'AWAITING_APPROVAL', submitted_at = now() WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );

    await client.query('COMMIT');
    return await getBillById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------- approve and void

interface PostingAccounts {
  payableAccountId: string;
  taxAccountId: string | null;
}

/**
 * Resolves the payable and (if needed) tax-input accounts to post a bill
 * against: `ledger_settings` first, falling back to the default chart's
 * `2100`/`1180`. Fails loudly rather than guessing further.
 */
async function resolveApAccounts(
  client: PoolClient,
  orgId: string,
  needsTaxAccount: boolean,
): Promise<PostingAccounts> {
  const { rows } = await client.query<{
    payable_account_id: string | null;
    tax_input_account_id: string | null;
  }>('SELECT payable_account_id, tax_input_account_id FROM ledger_settings WHERE org_id = $1', [
    orgId,
  ]);
  const settings = rows[0] ?? { payable_account_id: null, tax_input_account_id: null };

  async function fallbackAccountId(code: string): Promise<string | null> {
    const { rows: accountRows } = await client.query<{ id: string }>(
      'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
      [orgId, code],
    );
    return accountRows[0]?.id ?? null;
  }

  const payableAccountId = settings.payable_account_id ?? (await fallbackAccountId('2100'));
  if (payableAccountId === null) {
    throw new ApiError(422, 'No payable account is configured. Set one in settings.');
  }

  let taxAccountId: string | null = null;
  if (needsTaxAccount) {
    taxAccountId = settings.tax_input_account_id ?? (await fallbackAccountId('1180'));
    if (taxAccountId === null) {
      throw new ApiError(422, 'No tax account is configured. Set one in settings.');
    }
  }

  return { payableAccountId, taxAccountId };
}

export async function approveBill(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<Bill> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: billRows } = await client.query<{
      id: string;
      status: string;
      bill_date: string;
      vendor_name_snapshot: string;
      vendor_reference: string;
      total_cents: string;
      tax_cents: string;
    }>(
      `SELECT id, status, bill_date, vendor_name_snapshot, vendor_reference, total_cents, tax_cents
         FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [id, orgId],
    );
    const billRow = billRows[0];
    if (billRow === undefined) throw new ApiError(404, 'Bill not found');
    if (!isBillStatus(billRow.status)) {
      throw new Error(`Unknown bill status "${billRow.status}" on bill ${id}`);
    }
    if (!canTransitionBill(billRow.status, 'POSTED')) {
      throw new ApiError(409, `A bill that is ${billRow.status} cannot be approved`);
    }

    const { rows: lineRows } = await client.query<{
      expense_account_id: string;
      net_cents: string;
    }>(
      'SELECT expense_account_id, net_cents FROM bill_lines WHERE bill_id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (lineRows.length === 0) {
      throw new ApiError(422, 'A bill needs at least one line before it can be approved');
    }

    const totalCents = parseCents(billRow.total_cents);
    const taxTotalCents = parseCents(billRow.tax_cents);

    const { payableAccountId, taxAccountId } = await resolveApAccounts(
      client,
      orgId,
      taxTotalCents > 0,
    );

    // One debit line per distinct expense account — two bill lines on the
    // same account merge into a single ledger line.
    const expenseByAccount = new Map<string, number>();
    for (const line of lineRows) {
      const net = parseCents(line.net_cents);
      expenseByAccount.set(
        line.expense_account_id,
        (expenseByAccount.get(line.expense_account_id) ?? 0) + net,
      );
    }

    const glLines = [
      ...[...expenseByAccount.entries()].map(([accountId, netCents]) => ({
        accountId,
        debitCents: netCents,
        creditCents: 0,
      })),
      { accountId: payableAccountId, debitCents: 0, creditCents: totalCents },
    ];
    if (taxAccountId !== null && taxTotalCents > 0) {
      glLines.push({ accountId: taxAccountId, debitCents: taxTotalCents, creditCents: 0 });
    }

    const debitTotal = sumCents(glLines.map((l) => cents(l.debitCents)));
    const creditTotal = sumCents(glLines.map((l) => cents(l.creditCents)));
    if (debitTotal !== creditTotal) {
      // A bug, not user input — the invariant that totalCents = subtotal + tax
      // and that line net/tax sum to those totals should make this impossible.
      throw new Error('Bill posting is unbalanced');
    }

    const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
      entryDate: entryDate ?? billRow.bill_date,
      description: `Bill ${billRow.vendor_reference} — ${billRow.vendor_name_snapshot}`,
      sourceType: 'bill',
      sourceId: id,
      lines: glLines,
    });

    await client.query(
      `UPDATE bills
          SET status = 'POSTED', journal_entry_id = $1, posted_at = now(), approved_by = $2
        WHERE id = $3 AND org_id = $4`,
      [journalEntryId, userId, id, orgId],
    );

    await client.query('COMMIT');
    return await getBillById(orgId, id);
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

export async function voidBill(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<Bill> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string; status: string; journal_entry_id: string | null }>(
      'SELECT id, status, journal_entry_id FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Bill not found');
    if (!isBillStatus(row.status)) {
      throw new Error(`Unknown bill status "${row.status}" on bill ${id}`);
    }
    if (!canTransitionBill(row.status, 'VOID')) {
      throw new ApiError(409, 'This bill has already been voided');
    }

    if (row.status === 'POSTED') {
      const { rows: allocatedRows } = await client.query<{ allocated: string }>(
        `SELECT COALESCE(SUM(pa.amount_cents), 0)::text AS allocated
           FROM payment_allocations pa
           JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
          WHERE pa.org_id = $1 AND pa.bill_id = $2 AND p.status = 'POSTED'`,
        [orgId, id],
      );
      if (parseCents(allocatedRows[0]?.allocated ?? '0') > 0) {
        throw new ApiError(409, 'This document has payments applied. Void the payments first.');
      }
    }

    if (row.status === 'POSTED') {
      if (row.journal_entry_id === null) {
        throw new Error(`Posted bill ${id} has no journal_entry_id`);
      }
      const reversalId = await journalService.reverseEntryOnClient(
        client,
        orgId,
        userId,
        row.journal_entry_id,
        entryDate,
      );
      await client.query(
        `UPDATE bills SET status = 'VOID', voided_at = now(), void_journal_entry_id = $1
          WHERE id = $2 AND org_id = $3`,
        [reversalId, id, orgId],
      );
    } else {
      // A draft/in-review bill never posted anything, so there is nothing to reverse.
      await client.query(
        `UPDATE bills SET status = 'VOID', voided_at = now() WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
    }

    await client.query('COMMIT');
    return await getBillById(orgId, id);
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
