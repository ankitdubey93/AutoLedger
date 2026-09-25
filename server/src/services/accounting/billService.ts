import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { allocateCents, cents, parseCents, scaleCents, sumCents } from '../../utils/money.js';
import { convertToBase, ONE_RATE } from '../../utils/fxRate.js';
import { emitEvent } from '../outboxService.js';
import * as journalService from './journalService.js';
import * as fxRateService from './fxRateService.js';
import * as paymentTermService from './paymentTermService.js';
import { allocatedCentsSubquery, noteAppliedCentsSubquery, settledCentsSubquery } from './settlementSql.js';
import { resolveApPostingAccountsOnClient, resolveInventoryPostingAccountsOnClient } from './settingsService.js';
import { classifyStockLinesOnClient, prepareStockLinesOnClient } from './documentStockLines.js';
import * as documentStockService from '../inventory/documentStockService.js';
import {
  canTransitionBill,
  isBillStatus,
  settlementStatusOf,
  type Bill,
  type BillLine,
  type BillStatus,
} from '../../types/accounting.js';
import { MODULE_TAGS } from '../../config/modules.js';

/**
 * Accounting bills — Phase 3.9's AP source document.
 *
 * A bill has FOUR lifecycle states, not three like an invoice: entry
 * (DRAFT), review (AWAITING_APPROVAL), posting (POSTED), and correction
 * (VOID). Approval is deliberately gated by a different role than entry
 * (routes/accounting/billRoutes.ts) — a segregation-of-duties control, and
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
  /** Phase 24 — which catalogue item this line was picked from, if any. Not
   * used to fill any other field here — the client already copied the
   * item's defaults into description/unitPriceCents/account/taxRateBp. */
  itemId: string | null;
  /** Phase 32 — where an INVENTORY line receives stock; null = the default location. Optional so
   * Capture's captured-bill path (no items) never has to name it. */
  stockLocationId?: string | null | undefined;
}

export interface CreateBillInput {
  vendorId: string;
  vendorReference: string;
  billDate: string;
  /** Omitted when paymentTermsCode is set — resolveDueDate derives it. */
  dueDate?: string | undefined;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string | undefined;
  notes: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
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
  payment_terms_code: string | null;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  fx_rate: string;
  base_subtotal_cents: string;
  base_tax_cents: string;
  base_total_cents: string;
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
  debited_cents: string;
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
  item_id: string | null;
  stock_location_id: string | null;
}

const BILL_SELECT = `SELECT b.id, b.vendor_reference, b.status, b.vendor_id, v.name AS vendor_name,
                             b.bill_date, b.due_date, b.currency_code,
                             b.vendor_name_snapshot, b.vendor_address_snapshot,
                             b.vendor_tax_number_snapshot, b.notes, b.payment_terms, b.payment_terms_code,
                             b.subtotal_cents, b.tax_cents, b.total_cents,
                             b.fx_rate::text AS fx_rate, b.base_subtotal_cents,
                             b.base_tax_cents, b.base_total_cents,
                             b.journal_entry_id, b.void_journal_entry_id,
                             b.submitted_at, b.posted_at, b.voided_at,
                             b.approved_by, au.name AS approved_by_name,
                             b.created_by, u.name AS created_by_name, b.created_at, b.updated_at,
                             ${allocatedCentsSubquery('b', 'bill_id')} AS allocated_cents,
                             ${noteAppliedCentsSubquery('b', 'bill_id')} AS debited_cents
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
    itemId: row.item_id,
    stockLocationId: row.stock_location_id,
  };
}

function toBill(row: BillRow, lines: BillLine[]): Bill {
  if (!isBillStatus(row.status)) {
    throw new Error(`Unknown bill status "${row.status}" on bill ${row.id}`);
  }

  const isOpen = row.status === 'POSTED';
  const totalCents = parseCents(row.total_cents);
  const allocatedCents = isOpen ? parseCents(row.allocated_cents) : 0;
  const debitedCents = isOpen ? parseCents(row.debited_cents) : 0;
  const amountDueCents = isOpen ? totalCents - allocatedCents - debitedCents : 0;
  // A debit note settles a bill exactly as a payment does, so a fully
  // debited bill reads PAID (Phase 26).
  const settlementStatus = settlementStatusOf({
    isOpen,
    totalCents,
    allocatedCents: allocatedCents + debitedCents,
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
    paymentTermsCode: row.payment_terms_code,
    subtotalCents: parseCents(row.subtotal_cents),
    taxCents: parseCents(row.tax_cents),
    totalCents,
    fxRate: row.fx_rate,
    baseSubtotalCents: parseCents(row.base_subtotal_cents),
    baseTaxCents: parseCents(row.base_tax_cents),
    baseTotalCents: parseCents(row.base_total_cents),
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
    debitedCents,
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
            l.tax_rate_bp, l.net_cents, l.tax_cents, l.item_id, l.stock_location_id
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
    clauses.push(`b.status = 'POSTED' AND b.total_cents > ${settledCentsSubquery('b', 'bill_id')}::bigint`);
  } else if (options.settlement === 'OVERDUE') {
    add(
      (p) =>
        `b.status = 'POSTED' AND b.total_cents > ${settledCentsSubquery('b', 'bill_id')}::bigint AND b.due_date < ${p}::date`,
      today(),
    );
  } else if (options.settlement === 'PAID') {
    clauses.push(`b.status = 'POSTED' AND b.total_cents <= ${settledCentsSubquery('b', 'bill_id')}::bigint`);
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
export async function assertExpenseAccounts(
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
}

/** Due-date resolution needs the transaction client (a term lookup), so it
 * cannot run inside the synchronous validateBillInput above — this runs once
 * the client is open, and re-checks the same ordering invariant against the
 * resolved date. */
async function resolveBillDueDate(
  client: PoolClient,
  orgId: string,
  input: Pick<CreateBillInput, 'billDate' | 'dueDate' | 'paymentTermsCode' | 'paymentTerms'>,
): Promise<{ dueDate: string; paymentTerms: string | null; paymentTermsCode: string | null }> {
  const resolved = await paymentTermService.resolveDueDate(
    client,
    orgId,
    input.billDate,
    input.paymentTermsCode,
    input.dueDate,
  );
  if (resolved.dueDate < input.billDate) {
    throw new ApiError(422, 'Due date cannot be before the bill date');
  }
  return {
    dueDate: resolved.dueDate,
    paymentTerms: input.paymentTerms ?? resolved.paymentTermsLabel,
    paymentTermsCode: resolved.paymentTermsCode,
  };
}

/**
 * Resolves the rate to convert `currencyCode` to `baseCurrency` on `onDate`
 * — identity (rate 1) when they match. Called on every draft save (so a
 * draft always displays an honest base total) and again at `approveBill`
 * (which freezes the result). Throws ApiError(422) via
 * fxRateService.requireRateOnClient when no rate exists on or before onDate.
 */
async function resolveDocumentFxRate(
  client: PoolClient,
  orgId: string,
  currencyCode: string,
  baseCurrency: string,
  onDate: string,
): Promise<string> {
  if (currencyCode === baseCurrency) return ONE_RATE;
  const resolved = await fxRateService.requireRateOnClient(client, orgId, currencyCode, baseCurrency, onDate);
  return resolved.rate;
}

async function insertBillLines(
  client: PoolClient,
  orgId: string,
  billId: string,
  totals: LineTotal[],
): Promise<void> {
  // Phase 32: an INVENTORY line always posts to its item's inventory account, whatever
  // account the client sent — stamped here so the stored line shows where it lands.
  // Also refuses (422) lot/serial items, fixed assets and a location on a non-stock line.
  const stockLines = await prepareStockLinesOnClient(
    client,
    orgId,
    totals.map((t, i) => ({
      lineNumber: i + 1,
      itemId: t.input.itemId,
      stockLocationId: t.input.stockLocationId ?? null,
      quantityMilli: t.input.quantityMilli,
    })),
  );
  await client.query(
    `INSERT INTO bill_lines
       (org_id, bill_id, line_number, description, quantity_milli, unit_price_cents,
        expense_account_id, tax_rate_bp, net_cents, tax_cents, item_id, stock_location_id)
     SELECT $1, $2, v.line_number, v.description, v.quantity_milli, v.unit_price_cents,
            v.expense_account_id, v.tax_rate_bp, v.net_cents, v.tax_cents, v.item_id, v.stock_location_id
       FROM unnest(
              $3::smallint[], $4::text[], $5::bigint[], $6::bigint[],
              $7::uuid[], $8::int[], $9::bigint[], $10::bigint[], $11::uuid[], $12::uuid[]
            ) AS v(line_number, description, quantity_milli, unit_price_cents,
                    expense_account_id, tax_rate_bp, net_cents, tax_cents, item_id, stock_location_id)`,
    [
      orgId,
      billId,
      totals.map((_, i) => i + 1),
      totals.map((t) => t.input.description),
      totals.map((t) => t.input.quantityMilli),
      totals.map((t) => t.input.unitPriceCents),
      totals.map((t, i) => stockLines.get(i + 1)?.accounts.assetAccountId ?? t.input.expenseAccountId),
      totals.map((t) => t.input.taxRateBp),
      totals.map((t) => t.netCents),
      totals.map((t) => t.taxCents),
      totals.map((t) => t.input.itemId),
      totals.map((t) => t.input.stockLocationId ?? null),
    ],
  );
}

/**
 * The already-resolved header `insertBillOnClient` writes — `dueDate` and
 * `paymentTermsCode` are the OUTPUT of `resolveBillDueDate`, never the raw
 * request, so this function never has to resolve a term itself.
 */
interface InsertBillHeader {
  vendorId: string;
  vendorReference: string;
  billDate: string;
  dueDate: string;
  currencyCode?: string | undefined;
  notes: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
}

/**
 * The body of `createBill`, extracted so `postingService.ts` (Phase 19) can
 * insert a DRAFT bill on its own already-open transaction. Every statement
 * runs on `client` (rule 5) — no BEGIN/COMMIT/ROLLBACK/release here, and no
 * error mapping either; the caller owns both.
 */
async function insertBillOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  header: InsertBillHeader,
  totals: LineTotal[],
): Promise<string> {
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;

  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
  const currencyCode = header.currencyCode ?? baseCurrency;

  const { rows: vendorRows } = await client.query<{
    name: string;
    billing_address: string | null;
    tax_number: string | null;
  }>(
    'SELECT name, billing_address, tax_number FROM vendors WHERE id = $1 AND org_id = $2 AND is_active = true',
    [header.vendorId, orgId],
  );
  const vendor = vendorRows[0];
  if (vendor === undefined) throw new ApiError(422, 'Vendor not found');

  await assertExpenseAccounts(
    client,
    orgId,
    totals.map((t) => t.input.expenseAccountId),
  );

  // Resolved on every draft save so the draft always displays an honest
  // base-currency total; frozen for good at approveBill.
  const fxRate = await resolveDocumentFxRate(client, orgId, currencyCode, baseCurrency, header.billDate);
  const baseSubtotalCents = convertToBase(subtotalCents, fxRate);
  const baseTaxCents = convertToBase(taxCents, fxRate);
  const baseTotalCents = baseSubtotalCents + baseTaxCents;

  const { rows: billRows } = await client.query<{ id: string }>(
    `INSERT INTO bills
       (org_id, vendor_id, vendor_reference, bill_date, due_date, currency_code,
        vendor_name_snapshot, vendor_address_snapshot, vendor_tax_number_snapshot,
        notes, payment_terms, payment_terms_code, subtotal_cents, tax_cents, total_cents,
        fx_rate, base_subtotal_cents, base_tax_cents, base_total_cents, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING id`,
    [
      orgId,
      header.vendorId,
      header.vendorReference,
      header.billDate,
      header.dueDate,
      currencyCode,
      vendor.name,
      vendor.billing_address,
      vendor.tax_number,
      header.notes,
      header.paymentTerms,
      header.paymentTermsCode,
      subtotalCents,
      taxCents,
      totalCents,
      fxRate,
      baseSubtotalCents,
      baseTaxCents,
      baseTotalCents,
      createdBy,
    ],
  );
  const billId = billRows[0]?.id;
  if (billId === undefined) throw new Error('INSERT ... RETURNING produced no row');

  await insertBillLines(client, orgId, billId, totals);

  return billId;
}

/**
 * Phase 34b — the core of `createBill`, runnable on a caller's own
 * transaction client (e.g. `recurringService.runDueOccurrences`). Runs no
 * BEGIN/COMMIT/ROLLBACK and maps no errors (rule 5) — the caller owns both.
 * Includes `validateBillInput`/`computeLineTotals` so a caller cannot skip
 * validation. Returns the new bill's id.
 */
export async function createBillOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  input: CreateBillInput,
): Promise<string> {
  validateBillInput(input);
  const totals = computeLineTotals(input.lines);

  const resolvedDue = await resolveBillDueDate(client, orgId, input);
  const billId = await insertBillOnClient(
    client,
    orgId,
    createdBy,
    {
      vendorId: input.vendorId,
      vendorReference: input.vendorReference,
      billDate: input.billDate,
      dueDate: resolvedDue.dueDate,
      currencyCode: input.currencyCode,
      notes: input.notes,
      paymentTerms: resolvedDue.paymentTerms,
      paymentTermsCode: resolvedDue.paymentTermsCode,
    },
    totals,
  );

  return billId;
}

export async function createBill(
  orgId: string,
  createdBy: string,
  input: CreateBillInput,
): Promise<Bill> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const billId = await createBillOnClient(client, orgId, createdBy, input);

    await client.query('COMMIT');
    return await getBillById(orgId, billId);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_bills_vendor_reference') {
      throw new ApiError(409, 'This vendor reference has already been entered for this vendor');
    }
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
      throw new ApiError(422, 'A referenced account or item does not exist in this organization');
    }
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Phase 19 — Capture's captured-bill posting. A DRAFT bill with explicit
 * per-line net/tax cents (already allocated by the caller — see
 * `utils/money.ts`'s `allocateCents`), inserted on the caller's own
 * transaction. Reuses `insertBillOnClient` by building an equivalent
 * `CreateBillInput` shape from `CapturedBillInput`'s pre-computed totals —
 * `computeLineTotals` is not called here, because a captured line's net/tax
 * are already final cents, not a quantity*price computation.
 */
export interface CapturedBillLineInput {
  description: string;
  netCents: number;
  taxCents: number;
  expenseAccountId: string;
}

export interface CapturedBillInput {
  vendorId: string;
  vendorReference: string;
  billDate: string;
  dueDate: string;
  currencyCode: string;
  notes: string | null;
  lines: CapturedBillLineInput[];
}

export async function createCapturedBillOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  input: CapturedBillInput,
): Promise<string> {
  const totals: LineTotal[] = input.lines.map((line) => ({
    input: {
      description: line.description,
      quantityMilli: 1000,
      unitPriceCents: line.netCents,
      expenseAccountId: line.expenseAccountId,
      taxRateBp: line.netCents === 0 ? 0 : Math.min(10000, Number(scaleCents(cents(line.taxCents), 10000, line.netCents))),
      // A captured (Capture) line never comes from the item catalogue.
      itemId: null,
    },
    netCents: line.netCents,
    taxCents: line.taxCents,
  }));

  validateBillInput({
    vendorId: input.vendorId,
    vendorReference: input.vendorReference,
    billDate: input.billDate,
    dueDate: input.dueDate,
    currencyCode: input.currencyCode,
    notes: input.notes,
    paymentTerms: null,
    paymentTermsCode: null,
    lines: totals.map((t) => t.input),
  });

  return insertBillOnClient(
    client,
    orgId,
    createdBy,
    {
      vendorId: input.vendorId,
      vendorReference: input.vendorReference,
      billDate: input.billDate,
      dueDate: input.dueDate,
      currencyCode: input.currencyCode,
      notes: input.notes,
      paymentTerms: null,
      paymentTermsCode: null,
    },
    totals,
  );
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
    await beginTransaction(client);

    const { rows: statusRows } = await client.query<{ status: string }>(
      'SELECT status FROM bills WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const statusRow = statusRows[0];
    if (statusRow === undefined) throw new ApiError(404, 'Bill not found');
    if (statusRow.status !== 'DRAFT' && statusRow.status !== 'AWAITING_APPROVAL') {
      throw new ApiError(409, 'Only a draft or in-review bill can be edited');
    }

    const { rows: orgRows } = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const baseCurrency = orgRows[0]?.base_currency.trim();
    if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
    const currencyCode = input.currencyCode ?? baseCurrency;

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

    const resolvedDue = await resolveBillDueDate(client, orgId, input);

    await assertExpenseAccounts(
      client,
      orgId,
      totals.map((t) => t.input.expenseAccountId),
    );

    const fxRate = await resolveDocumentFxRate(client, orgId, currencyCode, baseCurrency, input.billDate);
    const baseSubtotalCents = convertToBase(subtotalCents, fxRate);
    const baseTaxCents = convertToBase(taxCents, fxRate);
    const baseTotalCents = baseSubtotalCents + baseTaxCents;

    await client.query('DELETE FROM bill_lines WHERE bill_id = $1 AND org_id = $2', [id, orgId]);

    await client.query(
      `UPDATE bills
          SET vendor_id = $1, vendor_reference = $2, bill_date = $3, due_date = $4, currency_code = $5,
              vendor_name_snapshot = $6, vendor_address_snapshot = $7,
              vendor_tax_number_snapshot = $8, notes = $9, payment_terms = $10, payment_terms_code = $11,
              subtotal_cents = $12, tax_cents = $13, total_cents = $14,
              fx_rate = $15, base_subtotal_cents = $16, base_tax_cents = $17, base_total_cents = $18
        WHERE id = $19 AND org_id = $20`,
      [
        input.vendorId,
        input.vendorReference,
        input.billDate,
        resolvedDue.dueDate,
        currencyCode,
        vendor.name,
        vendor.billing_address,
        vendor.tax_number,
        input.notes,
        resolvedDue.paymentTerms,
        resolvedDue.paymentTermsCode,
        subtotalCents,
        taxCents,
        totalCents,
        fxRate,
        baseSubtotalCents,
        baseTaxCents,
        baseTotalCents,
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
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
      throw new ApiError(422, 'A referenced account or item does not exist in this organization');
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
  const { rows } = await withTransaction((client) =>
    client.query<{ id: string }>(
      `DELETE FROM bills
        WHERE id = $1 AND org_id = $2 AND status IN ('DRAFT', 'AWAITING_APPROVAL')
        RETURNING id`,
      [id, orgId],
    ),
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
    await beginTransaction(client);

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

/**
 * The body of `approveBill`, extracted so `postingService.ts` (Phase 19)
 * can approve a bill it just created on the same already-open transaction.
 * Every statement runs on `client` (rule 5) — no BEGIN/COMMIT/ROLLBACK/
 * release here, and no error mapping either; the caller owns both.
 */
export async function approveBillOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<{ journalEntryId: string }> {
  const { rows: billRows } = await client.query<{
    id: string;
    status: string;
    bill_date: string;
    due_date: string;
    vendor_id: string;
    vendor_name_snapshot: string;
    vendor_reference: string;
    currency_code: string;
    subtotal_cents: string;
    total_cents: string;
    tax_cents: string;
  }>(
    `SELECT id, status, bill_date, due_date, vendor_id, vendor_name_snapshot, vendor_reference,
            currency_code, subtotal_cents, total_cents, tax_cents
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
    line_number: number;
    quantity_milli: string;
    expense_account_id: string;
    net_cents: string;
    item_id: string | null;
    stock_location_id: string | null;
  }>(
    `SELECT line_number, quantity_milli, expense_account_id, net_cents, item_id, stock_location_id
       FROM bill_lines WHERE bill_id = $1 AND org_id = $2 ORDER BY line_number`,
    [id, orgId],
  );
  if (lineRows.length === 0) {
    throw new ApiError(422, 'A bill needs at least one line before it can be approved');
  }

  const totalCents = parseCents(billRow.total_cents);
  const subtotalCents = parseCents(billRow.subtotal_cents);
  const taxTotalCents = parseCents(billRow.tax_cents);
  const documentCurrency = billRow.currency_code.trim();
  const postingDate = entryDate ?? billRow.bill_date;

  // The rate is frozen HERE, at posting, re-resolved for the posting date
  // rather than trusting whatever the draft last saved for bill_date —
  // entryDate can differ from bill_date. Once approved this never changes
  // again; every later settlement compares its own rate against this one.
  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
  const fxRate = await resolveDocumentFxRate(client, orgId, documentCurrency, baseCurrency, postingDate);
  const baseSubtotalCents = convertToBase(subtotalCents, fxRate);
  const baseTaxCents = convertToBase(taxTotalCents, fxRate);
  const baseTotalCents = baseSubtotalCents + baseTaxCents;

  const { payableAccountId, taxAccountId } = await resolveApPostingAccountsOnClient(
    client,
    orgId,
    taxTotalCents > 0,
  );

  // Phase 32 — INVENTORY lines receive stock instead of expensing. Classified
  // here (again — the draft-save check can be stale) and posted to the item's
  // inventory account. The stock is received BEFORE the journal is built: lock
  // order is bill row -> stock balances -> journal (documentStockService header).
  const stockLines = await classifyStockLinesOnClient(
    client,
    orgId,
    lineRows.map((l) => ({
      lineNumber: l.line_number,
      itemId: l.item_id,
      stockLocationId: l.stock_location_id,
      quantityMilli: Number(l.quantity_milli),
    })),
  );
  const stockAccountIds = new Set([...stockLines.values()].map((l) => l.accounts.assetAccountId));
  for (const line of lineRows) {
    if (!stockLines.has(line.line_number) && stockAccountIds.has(line.expense_account_id)) {
      // Otherwise the GL inventory account would gain value the stock ledger never saw.
      throw new ApiError(422, `Line ${String(line.line_number)} posts to an inventory account that only inventory items may use on a bill`);
    }
  }

  if (stockLines.size > 0) {
    // Inventory value is BASE currency. Convert each inventory account's net
    // total once — exactly what the journal will do for that debit line — then
    // split it across the lines with largest-remainder so the receipts add up
    // to the GL debit to the cent.
    const byAccount = new Map<string, { lineNumber: number; netCents: number }[]>();
    for (const line of lineRows) {
      const stock = stockLines.get(line.line_number);
      if (stock === undefined) continue;
      const group = byAccount.get(stock.accounts.assetAccountId) ?? [];
      group.push({ lineNumber: line.line_number, netCents: parseCents(line.net_cents) });
      byAccount.set(stock.accounts.assetAccountId, group);
    }
    const valueByLine = new Map<number, number>();
    for (const group of byAccount.values()) {
      const net = group.reduce((sum, l) => sum + l.netCents, 0);
      const baseNet = convertToBase(cents(net), fxRate);
      const shares =
        net === 0
          ? group.map(() => 0)
          : allocateCents(cents(baseNet), group.map((l) => cents(l.netCents))).map((c) => Number(c));
      group.forEach((l, i) => valueByLine.set(l.lineNumber, shares[i] ?? 0));
    }

    await documentStockService.receiveForDocumentOnClient(client, orgId, userId, {
      sourceType: 'bill',
      sourceId: id,
      occurredOn: postingDate,
      reference: billRow.vendor_reference,
      lines: [...stockLines.values()].map((l) => ({
        lineNumber: l.lineNumber,
        ledgerItemId: l.itemId,
        locationId: l.stockLocationId,
        quantityMilli: l.quantityMilli,
        glAccountId: l.accounts.assetAccountId,
        valueCents: valueByLine.get(l.lineNumber) ?? 0,
      })),
    });
  }

  // One debit line per distinct account — two bill lines on the same account
  // merge into a single ledger line. An INVENTORY line's account is its item's
  // inventory account, not whatever the draft line carried.
  const expenseByAccount = new Map<string, number>();
  for (const line of lineRows) {
    const net = parseCents(line.net_cents);
    const accountId = stockLines.get(line.line_number)?.accounts.assetAccountId ?? line.expense_account_id;
    expenseByAccount.set(accountId, (expenseByAccount.get(accountId) ?? 0) + net);
  }

  const glLines = [
    ...[...expenseByAccount.entries()].map(([accountId, netCents]) => ({
      accountId,
      debitCents: netCents,
      creditCents: 0,
      currencyCode: documentCurrency,
      fxRate,
    })),
    { accountId: payableAccountId, debitCents: 0, creditCents: totalCents, currencyCode: documentCurrency, fxRate },
  ];
  if (taxAccountId !== null && taxTotalCents > 0) {
    glLines.push({
      accountId: taxAccountId,
      debitCents: taxTotalCents,
      creditCents: 0,
      currencyCode: documentCurrency,
      fxRate,
    });
  }

  const debitTotal = sumCents(glLines.map((l) => cents(l.debitCents)));
  const creditTotal = sumCents(glLines.map((l) => cents(l.creditCents)));
  if (debitTotal !== creditTotal) {
    // A bug, not user input — the invariant that totalCents = subtotal + tax
    // and that line net/tax sum to those totals should make this impossible.
    throw new Error('Bill posting is unbalanced');
  }

  const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
    entryDate: postingDate,
    description: `Bill ${billRow.vendor_reference} — ${billRow.vendor_name_snapshot}`,
    sourceType: 'bill',
    sourceId: id,
    lines: glLines,
  });

  await client.query(
    `UPDATE bills
        SET status = 'POSTED', journal_entry_id = $1, posted_at = now(), approved_by = $2,
            fx_rate = $3, base_subtotal_cents = $4, base_tax_cents = $5, base_total_cents = $6
      WHERE id = $7 AND org_id = $8`,
    [journalEntryId, userId, fxRate, baseSubtotalCents, baseTaxCents, baseTotalCents, id, orgId],
  );

  await emitEvent(client, orgId, MODULE_TAGS.accounting, 'bill.approved', {
    billId: billRow.id,
    vendorId: billRow.vendor_id,
    vendorName: billRow.vendor_name_snapshot,
    vendorReference: billRow.vendor_reference,
    billDate: billRow.bill_date,
    dueDate: billRow.due_date,
    currencyCode: billRow.currency_code,
    subtotalCents: parseCents(billRow.subtotal_cents),
    taxCents: taxTotalCents,
    totalCents: totalCents,
    fxRate,
    baseTotalCents,
    journalEntryId,
  });

  return { journalEntryId };
}

export async function approveBill(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<Bill> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await approveBillOnClient(client, orgId, userId, id, entryDate);
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

/**
 * A receipt reversal removes the ORIGINAL value unless the balance no longer
 * holds that much (a later issue at a lower average, say) — then it is clamped.
 * The bill's reversing journal entry reverses the full original debit, so the
 * clamped difference is re-posted here: Dr Inventory / Cr Inventory adjustments.
 * Stock ledger and GL stay equal.
 */
async function postReceiptVarianceOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  billId: string,
  originalEntryId: string,
  entryDate: string | null,
  byAccount: { glAccountId: string; originalValueCents: number; reversedValueCents: number }[],
): Promise<void> {
  const variances = byAccount
    .map((a) => ({ accountId: a.glAccountId, cents: a.originalValueCents + a.reversedValueCents }))
    .filter((v) => v.cents > 0);
  if (variances.length === 0) return;

  const { adjustmentAccountId } = await resolveInventoryPostingAccountsOnClient(client, orgId);
  if (adjustmentAccountId === null) {
    throw new ApiError(422, 'No inventory-adjustment account is configured. Set one in settings.');
  }
  let date = entryDate;
  if (date === null) {
    const { rows } = await client.query<{ entry_date: string }>(
      'SELECT entry_date FROM journal_entries WHERE id = $1 AND org_id = $2',
      [originalEntryId, orgId],
    );
    date = rows[0]?.entry_date ?? null;
    if (date === null) throw new Error('bill journal entry not found');
  }
  const total = variances.reduce((sum, v) => sum + v.cents, 0);
  await journalService.createEntryOnClient(client, orgId, userId, {
    entryDate: date,
    description: 'Void bill — received stock already partly consumed',
    sourceType: 'bill',
    sourceId: billId,
    lines: [
      ...variances.map((v) => ({ accountId: v.accountId, debitCents: v.cents, creditCents: 0 })),
      { accountId: adjustmentAccountId, debitCents: 0, creditCents: total },
    ],
  });
}

export async function voidBill(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<Bill> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

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

      // Phase 26 — a bill that a debit note corrects (or that a debit was
      // applied to) cannot disappear from under that note.
      const { rows: noteRows } = await client.query<{ has_notes: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM debit_notes WHERE org_id = $1 AND bill_id = $2 AND status = 'ISSUED')
             OR EXISTS (SELECT 1 FROM debit_note_allocations a
                          JOIN debit_notes n ON n.id = a.debit_note_id AND n.org_id = a.org_id
                         WHERE a.org_id = $1 AND a.bill_id = $2 AND n.status = 'ISSUED') AS has_notes`,
        [orgId, id],
      );
      if (noteRows[0]?.has_notes === true) {
        throw new ApiError(409, 'This bill has debit notes. Void the debit notes first.');
      }
    }

    if (row.status === 'POSTED') {
      if (row.journal_entry_id === null) {
        throw new Error(`Posted bill ${id} has no journal_entry_id`);
      }
      // Phase 32: undo the bill's stock FIRST (lock order: bill row -> stock
      // balances -> journal). Refuses with 409 if the received stock has since
      // been issued.
      const stockReversal = await documentStockService.reverseDocumentOnClient(client, orgId, userId, {
        sourceType: 'bill',
        sourceId: id,
        occurredOn: entryDate,
      });
      const reversalId = await journalService.reverseEntryOnClient(
        client,
        orgId,
        userId,
        row.journal_entry_id,
        entryDate,
      );
      await postReceiptVarianceOnClient(client, orgId, userId, id, row.journal_entry_id, entryDate, stockReversal.byAccount);
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
