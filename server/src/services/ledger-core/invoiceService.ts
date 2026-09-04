import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, scaleCents, sumCents } from '../../utils/money.js';
import * as journalService from './journalService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import { allocatedCentsSubquery } from './paymentService.js';
import {
  canTransitionInvoice,
  isInvoiceStatus,
  settlementStatusOf,
  type Invoice,
  type InvoiceLine,
  type InvoiceStatus,
} from '../../types/ledger-core.js';

/**
 * LedgerCore sales invoices — Phase 3.8's AR source document.
 *
 * A DRAFT is an ordinary editable row: it has posted nothing, so `updateInvoice`
 * and `deleteInvoice` are legitimate (not a rule 6 violation). Once issued, an
 * invoice is immutable in the database as well as in this service — migration
 * 009's `trg_invoices_immutable` trigger enforces it independently. The only
 * correction path for an issued invoice is `voidInvoice`, which posts a
 * reversing journal entry, exactly like `journalService.reverseEntry` does for
 * a manual entry (guardrails rule 6).
 *
 * This file never writes `journal_entries` or `ledger_lines` directly — every
 * GL posting goes through `journalService`'s `*OnClient` functions on this
 * service's own checked-out transaction client (guardrails rules 5 and 16).
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
    return typeof err.message === 'string' ? err.message : 'Database rejected the invoice';
  }
  return 'Database rejected the invoice';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface InvoiceLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  revenueAccountId: string;
  taxRateBp: number;
}

export interface CreateInvoiceInput {
  customerId: string;
  issueDate: string;
  dueDate: string;
  notes: string | null;
  paymentTerms: string | null;
  lines: InvoiceLineInput[];
}

export type UpdateInvoiceInput = CreateInvoiceInput;

export interface ListInvoicesOptions {
  page: number;
  limit: number;
  status: InvoiceStatus | null;
  customerId: string | null;
  from: string | null;
  to: string | null;
  q: string | null;
  /** `null` for no filter. OUTSTANDING/OVERDUE/PAID all imply status = ISSUED. */
  settlement: 'OUTSTANDING' | 'OVERDUE' | 'PAID' | null;
}

// ---------------------------------------------------------------- row mapping

interface InvoiceRow {
  id: string;
  invoice_number: string | null;
  status: string;
  customer_id: string;
  customer_name: string;
  issue_date: string;
  due_date: string;
  currency_code: string;
  customer_name_snapshot: string;
  customer_address_snapshot: string | null;
  customer_tax_number_snapshot: string | null;
  notes: string | null;
  payment_terms: string | null;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  journal_entry_id: string | null;
  void_journal_entry_id: string | null;
  issued_at: Date | null;
  voided_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  allocated_cents: string;
}

interface InvoiceLineRow {
  id: string;
  invoice_id: string;
  line_number: number;
  description: string;
  quantity_milli: string;
  unit_price_cents: string;
  revenue_account_id: string;
  revenue_account_code: string;
  revenue_account_name: string;
  tax_rate_bp: number;
  net_cents: string;
  tax_cents: string;
}

const INVOICE_SELECT = `SELECT i.id, i.invoice_number, i.status, i.customer_id, c.name AS customer_name,
                                i.issue_date, i.due_date, i.currency_code,
                                i.customer_name_snapshot, i.customer_address_snapshot,
                                i.customer_tax_number_snapshot, i.notes, i.payment_terms,
                                i.subtotal_cents, i.tax_cents, i.total_cents,
                                i.journal_entry_id, i.void_journal_entry_id, i.issued_at, i.voided_at,
                                i.created_by, u.name AS created_by_name, i.created_at, i.updated_at,
                                ${allocatedCentsSubquery('i', 'invoice_id')} AS allocated_cents
                           FROM invoices i
                           JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
                           LEFT JOIN users u ON u.id = i.created_by`;

function toLine(row: InvoiceLineRow): InvoiceLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    description: row.description,
    quantityMilli: Number(row.quantity_milli),
    unitPriceCents: parseCents(row.unit_price_cents),
    revenueAccountId: row.revenue_account_id,
    revenueAccountCode: row.revenue_account_code,
    revenueAccountName: row.revenue_account_name,
    taxRateBp: row.tax_rate_bp,
    netCents: parseCents(row.net_cents),
    taxCents: parseCents(row.tax_cents),
  };
}

function toInvoice(row: InvoiceRow, lines: InvoiceLine[]): Invoice {
  if (!isInvoiceStatus(row.status)) {
    throw new Error(`Unknown invoice status "${row.status}" on invoice ${row.id}`);
  }

  const isOpen = row.status === 'ISSUED';
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
    invoiceNumber: row.invoice_number,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    currencyCode: row.currency_code.trim(),
    customerNameSnapshot: row.customer_name_snapshot,
    customerAddressSnapshot: row.customer_address_snapshot,
    customerTaxNumberSnapshot: row.customer_tax_number_snapshot,
    notes: row.notes,
    paymentTerms: row.payment_terms,
    subtotalCents: parseCents(row.subtotal_cents),
    taxCents: parseCents(row.tax_cents),
    totalCents,
    journalEntryId: row.journal_entry_id,
    voidJournalEntryId: row.void_journal_entry_id,
    issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
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

/** Loads the lines for a set of invoices in one query — never one query per invoice. */
async function loadLines(
  orgId: string,
  invoiceIds: string[],
): Promise<Map<string, InvoiceLine[]>> {
  const byInvoice = new Map<string, InvoiceLine[]>();
  if (invoiceIds.length === 0) return byInvoice;

  const { rows } = await pool.query<InvoiceLineRow>(
    `SELECT l.id, l.invoice_id, l.line_number, l.description, l.quantity_milli, l.unit_price_cents,
            l.revenue_account_id, a.code AS revenue_account_code, a.name AS revenue_account_name,
            l.tax_rate_bp, l.net_cents, l.tax_cents
       FROM invoice_lines l
       JOIN accounts a ON a.id = l.revenue_account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.invoice_id = ANY($2::uuid[])
      ORDER BY l.line_number ASC`,
    [orgId, invoiceIds],
  );

  for (const row of rows) {
    const list = byInvoice.get(row.invoice_id) ?? [];
    list.push(toLine(row));
    byInvoice.set(row.invoice_id, list);
  }
  return byInvoice;
}

// ---------------------------------------------------------------------- reads

export async function getInvoiceById(orgId: string, id: string): Promise<Invoice> {
  const { rows } = await pool.query<InvoiceRow>(
    `${INVOICE_SELECT} WHERE i.id = $1 AND i.org_id = $2`,
    [id, orgId],
  );

  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Invoice not found');

  const lines = await loadLines(orgId, [row.id]);
  return toInvoice(row, lines.get(row.id) ?? []);
}

/**
 * Builds one shared `WHERE` predicate for both the count and the page query,
 * exactly like `journalService.buildFilters` — sharing it is what keeps
 * `totalCount` honest under a filter.
 */
function buildFilters(
  orgId: string,
  options: ListInvoicesOptions,
): { where: string; values: unknown[] } {
  const clauses = ['i.org_id = $1'];
  const values: unknown[] = [orgId];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  if (options.status !== null) add((p) => `i.status = ${p}`, options.status);
  if (options.customerId !== null) add((p) => `i.customer_id = ${p}::uuid`, options.customerId);
  if (options.from !== null) add((p) => `i.issue_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `i.issue_date <= ${p}::date`, options.to);
  // `alias` and `column` below are our own constants, never request input (rule 4).
  if (options.settlement === 'OUTSTANDING') {
    clauses.push(`i.status = 'ISSUED' AND i.total_cents > ${allocatedCentsSubquery('i', 'invoice_id')}::bigint`);
  } else if (options.settlement === 'OVERDUE') {
    add(
      (p) =>
        `i.status = 'ISSUED' AND i.total_cents > ${allocatedCentsSubquery('i', 'invoice_id')}::bigint AND i.due_date < ${p}::date`,
      today(),
    );
  } else if (options.settlement === 'PAID') {
    clauses.push(`i.status = 'ISSUED' AND i.total_cents <= ${allocatedCentsSubquery('i', 'invoice_id')}::bigint`);
  }
  if (options.q !== null)
    add(
      (p) =>
        `(i.invoice_number ILIKE '%' || ${p} || '%' OR i.customer_name_snapshot ILIKE '%' || ${p} || '%')`,
      options.q,
    );

  return { where: clauses.join(' AND '), values };
}

export async function listInvoices(
  orgId: string,
  options: ListInvoicesOptions,
): Promise<{ invoices: Invoice[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const { where, values } = buildFilters(orgId, options);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM invoices i WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  // `i.id DESC` is a required tiebreaker: two invoices sharing an issue_date
  // and created_at could otherwise swap between pages.
  const { rows } = await pool.query<InvoiceRow>(
    `${INVOICE_SELECT}
      WHERE ${where}
      ORDER BY i.issue_date DESC, i.created_at DESC, i.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  const lines = await loadLines(
    orgId,
    rows.map((r) => r.id),
  );

  return {
    invoices: rows.map((row) => toInvoice(row, lines.get(row.id) ?? [])),
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

/** Confirms every revenue account exists in this org, is postable, and is type Revenue. */
async function assertRevenueAccounts(
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
    throw new ApiError(422, 'Revenue account not found');
  }
  const header = rows.find((row) => !row.is_postable);
  if (header !== undefined) {
    throw new ApiError(422, `Account ${header.code} is a header account and cannot be posted to`);
  }
  const wrongType = rows.find((row) => row.type !== 'Revenue');
  if (wrongType !== undefined) {
    throw new ApiError(422, `Account ${wrongType.code} is not a Revenue account`);
  }
}

interface LineTotal {
  input: InvoiceLineInput;
  netCents: number;
  taxCents: number;
}

/**
 * Tax is computed per line and then summed — never on the subtotal — so a
 * mixed-rate invoice is correct and the stored line values reconcile to the
 * header exactly, which `chk_invoices_total` asserts.
 */
function computeLineTotals(lines: InvoiceLineInput[]): LineTotal[] {
  return lines.map((line) => {
    const netCents = scaleCents(cents(line.unitPriceCents), line.quantityMilli, 1000);
    const taxCents = scaleCents(netCents, line.taxRateBp, 10000);
    return { input: line, netCents, taxCents };
  });
}

function validateInvoiceInput(input: CreateInvoiceInput): void {
  if (input.lines.length === 0) {
    throw new ApiError(422, 'An invoice needs at least one line');
  }
  if (input.dueDate < input.issueDate) {
    throw new ApiError(422, 'Due date cannot be before the issue date');
  }
}

async function insertInvoiceLines(
  client: PoolClient,
  orgId: string,
  invoiceId: string,
  totals: LineTotal[],
): Promise<void> {
  await client.query(
    `INSERT INTO invoice_lines
       (org_id, invoice_id, line_number, description, quantity_milli, unit_price_cents,
        revenue_account_id, tax_rate_bp, net_cents, tax_cents)
     SELECT $1, $2, v.line_number, v.description, v.quantity_milli, v.unit_price_cents,
            v.revenue_account_id, v.tax_rate_bp, v.net_cents, v.tax_cents
       FROM unnest(
              $3::smallint[], $4::text[], $5::bigint[], $6::bigint[],
              $7::uuid[], $8::int[], $9::bigint[], $10::bigint[]
            ) AS v(line_number, description, quantity_milli, unit_price_cents,
                    revenue_account_id, tax_rate_bp, net_cents, tax_cents)`,
    [
      orgId,
      invoiceId,
      totals.map((_, i) => i + 1),
      totals.map((t) => t.input.description),
      totals.map((t) => t.input.quantityMilli),
      totals.map((t) => t.input.unitPriceCents),
      totals.map((t) => t.input.revenueAccountId),
      totals.map((t) => t.input.taxRateBp),
      totals.map((t) => t.netCents),
      totals.map((t) => t.taxCents),
    ],
  );
}

export async function createInvoice(
  orgId: string,
  createdBy: string,
  input: CreateInvoiceInput,
): Promise<Invoice> {
  validateInvoiceInput(input);
  const totals = computeLineTotals(input.lines);
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: orgRows } = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const currencyCode = orgRows[0]?.base_currency.trim();
    if (currencyCode === undefined) throw new ApiError(404, 'Organization not found');

    const { rows: customerRows } = await client.query<{
      name: string;
      billing_address: string | null;
      tax_number: string | null;
    }>(
      'SELECT name, billing_address, tax_number FROM customers WHERE id = $1 AND org_id = $2 AND is_active = true',
      [input.customerId, orgId],
    );
    const customer = customerRows[0];
    if (customer === undefined) throw new ApiError(422, 'Customer not found');

    await assertRevenueAccounts(
      client,
      orgId,
      totals.map((t) => t.input.revenueAccountId),
    );

    const { rows: invoiceRows } = await client.query<{ id: string }>(
      `INSERT INTO invoices
         (org_id, customer_id, issue_date, due_date, currency_code,
          customer_name_snapshot, customer_address_snapshot, customer_tax_number_snapshot,
          notes, payment_terms, subtotal_cents, tax_cents, total_cents, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        orgId,
        input.customerId,
        input.issueDate,
        input.dueDate,
        currencyCode,
        customer.name,
        customer.billing_address,
        customer.tax_number,
        input.notes,
        input.paymentTerms,
        subtotalCents,
        taxCents,
        totalCents,
        createdBy,
      ],
    );
    const invoiceId = invoiceRows[0]?.id;
    if (invoiceId === undefined) throw new Error('INSERT ... RETURNING produced no row');

    await insertInvoiceLines(client, orgId, invoiceId, totals);

    await client.query('COMMIT');
    return await getInvoiceById(orgId, invoiceId);
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

/** A draft edit replaces the whole document — the document is small and the client carries no line identity to diff against. */
export async function updateInvoice(
  orgId: string,
  id: string,
  input: UpdateInvoiceInput,
): Promise<Invoice> {
  validateInvoiceInput(input);
  const totals = computeLineTotals(input.lines);
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: statusRows } = await client.query<{ status: string }>(
      'SELECT status FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const statusRow = statusRows[0];
    if (statusRow === undefined) throw new ApiError(404, 'Invoice not found');
    if (statusRow.status !== 'DRAFT') {
      throw new ApiError(409, 'Only a draft invoice can be edited');
    }

    const { rows: customerRows } = await client.query<{
      name: string;
      billing_address: string | null;
      tax_number: string | null;
    }>(
      'SELECT name, billing_address, tax_number FROM customers WHERE id = $1 AND org_id = $2 AND is_active = true',
      [input.customerId, orgId],
    );
    const customer = customerRows[0];
    if (customer === undefined) throw new ApiError(422, 'Customer not found');

    await assertRevenueAccounts(
      client,
      orgId,
      totals.map((t) => t.input.revenueAccountId),
    );

    await client.query('DELETE FROM invoice_lines WHERE invoice_id = $1 AND org_id = $2', [
      id,
      orgId,
    ]);

    await client.query(
      `UPDATE invoices
          SET customer_id = $1, issue_date = $2, due_date = $3,
              customer_name_snapshot = $4, customer_address_snapshot = $5,
              customer_tax_number_snapshot = $6, notes = $7, payment_terms = $8,
              subtotal_cents = $9, tax_cents = $10, total_cents = $11
        WHERE id = $12 AND org_id = $13`,
      [
        input.customerId,
        input.issueDate,
        input.dueDate,
        customer.name,
        customer.billing_address,
        customer.tax_number,
        input.notes,
        input.paymentTerms,
        subtotalCents,
        taxCents,
        totalCents,
        id,
        orgId,
      ],
    );

    await insertInvoiceLines(client, orgId, id, totals);

    await client.query('COMMIT');
    return await getInvoiceById(orgId, id);
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

export async function deleteInvoice(orgId: string, id: string): Promise<void> {
  const { rows } = await withTransaction((client) =>
    client.query<{ id: string }>(
      `DELETE FROM invoices WHERE id = $1 AND org_id = $2 AND status = 'DRAFT' RETURNING id`,
      [id, orgId],
    ),
  );

  if (rows[0] !== undefined) return;

  // No row deleted: distinguish "does not exist" from "exists but not a draft".
  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM invoices WHERE id = $1 AND org_id = $2',
    [id, orgId],
  );
  if (existing[0] === undefined) throw new ApiError(404, 'Invoice not found');
  throw new ApiError(409, 'Only a draft invoice can be deleted');
}

// ----------------------------------------------------------- issue and void

interface PostingAccounts {
  receivableAccountId: string;
  taxAccountId: string | null;
}

/**
 * Resolves the receivable and (if needed) tax accounts to post an invoice
 * against: the org's invoice settings first, falling back to the default
 * chart's `1120`/`2140`. Fails loudly rather than guessing further.
 */
async function resolvePostingAccounts(
  client: PoolClient,
  orgId: string,
  needsTaxAccount: boolean,
): Promise<PostingAccounts> {
  const settings = await invoiceSettingsService.getInvoiceSettings(orgId);

  async function fallbackAccountId(code: string): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
      [orgId, code],
    );
    return rows[0]?.id ?? null;
  }

  const receivableAccountId =
    settings.receivableAccountId ?? (await fallbackAccountId('1120'));
  if (receivableAccountId === null) {
    throw new ApiError(422, 'No receivable account is configured. Set one in invoice settings.');
  }

  let taxAccountId: string | null = null;
  if (needsTaxAccount) {
    taxAccountId = settings.taxPayableAccountId ?? (await fallbackAccountId('2140'));
    if (taxAccountId === null) {
      throw new ApiError(422, 'No tax account is configured. Set one in invoice settings.');
    }
  }

  return { receivableAccountId, taxAccountId };
}

export async function issueInvoice(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<Invoice> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: invoiceRows } = await client.query<{
      id: string;
      status: string;
      issue_date: string;
      customer_name_snapshot: string;
      total_cents: string;
      tax_cents: string;
    }>(
      `SELECT id, status, issue_date, customer_name_snapshot, total_cents, tax_cents
         FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [id, orgId],
    );
    const invoiceRow = invoiceRows[0];
    if (invoiceRow === undefined) throw new ApiError(404, 'Invoice not found');
    if (!isInvoiceStatus(invoiceRow.status)) {
      throw new Error(`Unknown invoice status "${invoiceRow.status}" on invoice ${id}`);
    }
    if (!canTransitionInvoice(invoiceRow.status, 'ISSUED')) {
      throw new ApiError(409, `An invoice that is ${invoiceRow.status} cannot be issued`);
    }

    const { rows: lineRows } = await client.query<{
      revenue_account_id: string;
      net_cents: string;
    }>(
      'SELECT revenue_account_id, net_cents FROM invoice_lines WHERE invoice_id = $1 AND org_id = $2',
      [id, orgId],
    );
    if (lineRows.length === 0) {
      throw new ApiError(422, 'An invoice needs at least one line before it can be issued');
    }

    const totalCents = parseCents(invoiceRow.total_cents);
    const taxTotalCents = parseCents(invoiceRow.tax_cents);

    const { receivableAccountId, taxAccountId } = await resolvePostingAccounts(
      client,
      orgId,
      taxTotalCents > 0,
    );

    // One credit line per distinct revenue account — two invoice lines on the
    // same account merge into a single ledger line.
    const revenueByAccount = new Map<string, number>();
    for (const line of lineRows) {
      const net = parseCents(line.net_cents);
      revenueByAccount.set(
        line.revenue_account_id,
        (revenueByAccount.get(line.revenue_account_id) ?? 0) + net,
      );
    }

    const glLines = [
      { accountId: receivableAccountId, debitCents: totalCents, creditCents: 0 },
      ...[...revenueByAccount.entries()].map(([accountId, netCents]) => ({
        accountId,
        debitCents: 0,
        creditCents: netCents,
      })),
    ];
    if (taxAccountId !== null && taxTotalCents > 0) {
      glLines.push({ accountId: taxAccountId, debitCents: 0, creditCents: taxTotalCents });
    }

    const debitTotal = sumCents(glLines.map((l) => cents(l.debitCents)));
    const creditTotal = sumCents(glLines.map((l) => cents(l.creditCents)));
    if (debitTotal !== creditTotal) {
      // A bug, not user input — the invariant that totalCents = subtotal + tax
      // and that line net/tax sum to those totals should make this impossible.
      throw new Error('Invoice posting is unbalanced');
    }

    const invoiceNumber = await invoiceSettingsService.allocateInvoiceNumber(client, orgId);

    const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
      entryDate: entryDate ?? invoiceRow.issue_date,
      description: `Invoice ${invoiceNumber} — ${invoiceRow.customer_name_snapshot}`,
      sourceType: 'invoice',
      sourceId: id,
      lines: glLines,
    });

    await client.query(
      `UPDATE invoices
          SET status = 'ISSUED', invoice_number = $1, journal_entry_id = $2, issued_at = now()
        WHERE id = $3 AND org_id = $4`,
      [invoiceNumber, journalEntryId, id, orgId],
    );

    await client.query('COMMIT');
    return await getInvoiceById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_invoices_org_number') {
      throw new ApiError(409, 'Invoice number already exists — try again');
    }
    if (pgErrorCode(err) === PG_RAISE_EXCEPTION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function voidInvoice(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
): Promise<Invoice> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows } = await client.query<{ id: string; status: string; journal_entry_id: string | null }>(
      'SELECT id, status, journal_entry_id FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Invoice not found');
    if (!isInvoiceStatus(row.status)) {
      throw new Error(`Unknown invoice status "${row.status}" on invoice ${id}`);
    }
    if (!canTransitionInvoice(row.status, 'VOID')) {
      throw new ApiError(409, 'This invoice has already been voided');
    }

    if (row.status === 'ISSUED') {
      const { rows: allocatedRows } = await client.query<{ allocated: string }>(
        `SELECT COALESCE(SUM(pa.amount_cents), 0)::text AS allocated
           FROM payment_allocations pa
           JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
          WHERE pa.org_id = $1 AND pa.invoice_id = $2 AND p.status = 'POSTED'`,
        [orgId, id],
      );
      if (parseCents(allocatedRows[0]?.allocated ?? '0') > 0) {
        throw new ApiError(409, 'This document has payments applied. Void the payments first.');
      }
    }

    if (row.status === 'ISSUED') {
      if (row.journal_entry_id === null) {
        throw new Error(`Issued invoice ${id} has no journal_entry_id`);
      }
      const reversalId = await journalService.reverseEntryOnClient(
        client,
        orgId,
        userId,
        row.journal_entry_id,
        entryDate,
      );
      await client.query(
        `UPDATE invoices SET status = 'VOID', voided_at = now(), void_journal_entry_id = $1
          WHERE id = $2 AND org_id = $3`,
        [reversalId, id, orgId],
      );
    } else {
      // A draft never posted anything, so there is nothing to reverse.
      await client.query(
        `UPDATE invoices SET status = 'VOID', voided_at = now() WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
    }

    await client.query('COMMIT');
    return await getInvoiceById(orgId, id);
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
