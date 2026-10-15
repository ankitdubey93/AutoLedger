import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction, withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, parseCents, sumCents } from '../../utils/money.js';
import { computeLineTotals, type LineTotal as DocumentLineTotal } from '../../utils/documentTotals.js';
import { convertToBase } from '../../utils/fxRate.js';
import type { FillMode, PlaceholderContext } from '../../utils/placeholders.js';
import { fillField, fillOptionalField, LINE_DESCRIPTION_MAX, NOTES_MAX } from '../../utils/placeholderFields.js';
import { emitEvent } from '../outboxService.js';
import * as journalService from './journalService.js';
import { applyCreditsOnClient, type ApplyCreditInput } from './availableCreditsService.js';
import type { JournalLineInput } from './journalService.js';
import { classifyStockLinesOnClient, prepareStockLinesOnClient } from './documentStockLines.js';
import { resolveStockAccountsOnClient } from './itemService.js';
import * as inventoryAccountingService from './inventoryAccountingService.js';
import * as documentStockService from '../inventory/documentStockService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import * as fxRateService from './fxRateService.js';
import * as paymentTermService from './paymentTermService.js';
import { assertOrderLineLinksOnClient, assertOrderReferenceOnClient } from './orderLineLinks.js';
import * as documentService from '../documentService.js';
import { hasPostedDepositApplicationsOnClient, listDepositApplicationsForDocument } from './depositApplicationQueries.js';
import { allocatedCentsSubquery, depositAppliedCentsSubquery, noteAppliedCentsSubquery, settledCentsSubquery } from './settlementSql.js';
import {
  canTransitionInvoice,
  isInvoiceStatus,
  settlementStatusOf,
  type Invoice,
  type InvoiceLine,
  type InvoiceStatus,
} from '../../types/accounting.js';
import { MODULE_TAGS } from '../../config/modules.js';
import { revertConversionOnClient } from './quoteStatusService.js';

/**
 * Accounting sales invoices — Phase 3.8's AR source document.
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
const PG_DEADLOCK_DETECTED = '40P01';
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
  /** Phase 24 — which catalogue item this line was picked from, if any. Not
   * used to fill any other field here — the client already copied the
   * item's defaults into description/unitPriceCents/account/taxRateBp. */
  itemId: string | null;
  /** Phase 32 — where an INVENTORY line issues stock from; null = the default location. */
  stockLocationId?: string | null | undefined;
  /** Phase 42 — the order line this line bills (partial invoicing). Validated by assertOrderLineLinksOnClient. */
  orderLineId?: string | null | undefined;
}

export interface CreateInvoiceInput {
  customerId: string;
  issueDate: string;
  /** Omitted when paymentTermsCode is set — resolveDueDate derives it. */
  dueDate?: string | undefined;
  /** Phase 8. Omitted means the organization's base currency. */
  currencyCode?: string | undefined;
  notes: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  lines: InvoiceLineInput[];
  /** Phase 43b — vault documents to link to the invoice in the same transaction. */
  attachmentDocumentIds?: string[] | undefined;
  /** Phase 43b — the sales order this invoice references. On an edit, `undefined` leaves the link alone and `null` clears it. */
  salesOrderId?: string | null | undefined;
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
  /** Optional so existing callers keep the newest-first default. */
  sort?: { key: InvoiceSortKey; direction: 'asc' | 'desc' };
}

/**
 * The columns a invoice list can be sorted by (2026-09-30). Keys come from the
 * request (validated by `readSort` against this list); the SQL comes only from
 * this constant table — request text never reaches an ORDER BY (rule 4).
 */
export const INVOICE_SORT_KEYS = ['issueDate', 'dueDate', 'number', 'customer', 'total', 'status'] as const;
export type InvoiceSortKey = (typeof INVOICE_SORT_KEYS)[number];
const INVOICE_SORT_COLUMNS: Record<InvoiceSortKey, string> = {
  issueDate: 'i.issue_date',
  dueDate: 'i.due_date',
  number: 'i.invoice_number',
  customer: 'i.customer_name_snapshot',
  total: 'i.total_cents',
  status: 'i.status',
};

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
  notes_template: string | null;
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
  issued_at: Date | null;
  voided_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  allocated_cents: string;
  credited_cents: string;
  deposit_applied_cents: string;
  source_quote_id: string | null;
  source_quote_number: string | null;
  source_quote_revision: number | null;
  kind: 'STANDARD' | 'DEPOSIT';
  deposit_for_order_id: string | null;
  sales_order_id: string | null;
  sales_order_number: string | null;
}

interface InvoiceLineRow {
  id: string;
  invoice_id: string;
  line_number: number;
  description: string;
  description_template: string | null;
  quantity_milli: string;
  unit_price_cents: string;
  revenue_account_id: string;
  revenue_account_code: string;
  revenue_account_name: string;
  tax_rate_bp: number;
  net_cents: string;
  tax_cents: string;
  item_id: string | null;
  stock_location_id: string | null;
  order_line_id: string | null;
}

const INVOICE_SELECT = `SELECT i.id, i.invoice_number, i.status, i.customer_id, c.name AS customer_name,
                                i.issue_date, i.due_date, i.currency_code,
                                i.customer_name_snapshot, i.customer_address_snapshot,
                                i.customer_tax_number_snapshot, i.notes, i.notes_template, i.payment_terms, i.payment_terms_code,
                                i.subtotal_cents, i.tax_cents, i.total_cents,
                                i.fx_rate::text AS fx_rate, i.base_subtotal_cents,
                                i.base_tax_cents, i.base_total_cents,
                                i.journal_entry_id, i.void_journal_entry_id, i.issued_at, i.voided_at,
                                i.created_by, u.name AS created_by_name, i.created_at, i.updated_at,
                                ${allocatedCentsSubquery('i', 'invoice_id')} AS allocated_cents,
                                ${noteAppliedCentsSubquery('i', 'invoice_id')} AS credited_cents,
                                ${depositAppliedCentsSubquery('i', 'invoice_id')} AS deposit_applied_cents,
                                q.id AS source_quote_id, q.quote_number AS source_quote_number,
                                q.revision AS source_quote_revision,
                                i.kind, i.deposit_for_order_id, i.sales_order_id,
                                (SELECT o.order_number FROM orders o
                                  WHERE o.org_id = i.org_id AND o.id = i.sales_order_id) AS sales_order_number
                           FROM invoices i
                           JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
                           LEFT JOIN users u ON u.id = i.created_by
                           LEFT JOIN quotes q ON q.id = i.source_quote_id AND q.org_id = i.org_id`;

function toLine(row: InvoiceLineRow): InvoiceLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    description: row.description,
    descriptionTemplate: row.description_template,
    quantityMilli: Number(row.quantity_milli),
    unitPriceCents: parseCents(row.unit_price_cents),
    revenueAccountId: row.revenue_account_id,
    revenueAccountCode: row.revenue_account_code,
    revenueAccountName: row.revenue_account_name,
    taxRateBp: row.tax_rate_bp,
    netCents: parseCents(row.net_cents),
    taxCents: parseCents(row.tax_cents),
    itemId: row.item_id,
    stockLocationId: row.stock_location_id,
    orderLineId: row.order_line_id,
  };
}

function toInvoice(row: InvoiceRow, lines: InvoiceLine[]): Invoice {
  if (!isInvoiceStatus(row.status)) {
    throw new Error(`Unknown invoice status "${row.status}" on invoice ${row.id}`);
  }

  const isOpen = row.status === 'ISSUED';
  const totalCents = parseCents(row.total_cents);
  const allocatedCents = isOpen ? parseCents(row.allocated_cents) : 0;
  const creditedCents = isOpen ? parseCents(row.credited_cents) : 0;
  const depositAppliedCents = isOpen ? parseCents(row.deposit_applied_cents) : 0;
  const amountDueCents = isOpen ? totalCents - allocatedCents - creditedCents - depositAppliedCents : 0;
  // A credit note settles an invoice exactly as a payment does, so a fully
  // credited invoice reads PAID (Phase 26).
  const settlementStatus = settlementStatusOf({
    isOpen,
    totalCents,
    allocatedCents: allocatedCents + creditedCents + depositAppliedCents,
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
    notesTemplate: row.notes_template,
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
    issuedAt: row.issued_at === null ? null : row.issued_at.toISOString(),
    voidedAt: row.voided_at === null ? null : row.voided_at.toISOString(),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lines,
    allocatedCents,
    creditedCents,
    depositAppliedCents,
    amountDueCents,
    settlementStatus,
    sourceQuote:
      row.source_quote_id === null || row.source_quote_number === null || row.source_quote_revision === null
        ? null
        : { id: row.source_quote_id, quoteNumber: row.source_quote_number, revision: row.source_quote_revision },
    kind: row.kind,
    depositForOrderId: row.deposit_for_order_id,
    salesOrderId: row.sales_order_id,
    salesOrderNumber: row.sales_order_number,
    depositApplications: [],
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
    `SELECT l.id, l.invoice_id, l.line_number, l.description, l.description_template,
            l.quantity_milli, l.unit_price_cents,
            l.revenue_account_id, a.code AS revenue_account_code, a.name AS revenue_account_name,
            l.tax_rate_bp, l.net_cents, l.tax_cents, l.item_id, l.stock_location_id,
            l.order_line_id
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
  const invoice = toInvoice(row, lines.get(row.id) ?? []);
  // Phase 42 — only the one-document read carries its applications.
  invoice.depositApplications = await listDepositApplicationsForDocument(pool, orgId, 'SALES', row.id);
  return invoice;
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
    clauses.push(`i.status = 'ISSUED' AND i.total_cents > ${settledCentsSubquery('i', 'invoice_id')}::bigint`);
  } else if (options.settlement === 'OVERDUE') {
    add(
      (p) =>
        `i.status = 'ISSUED' AND i.total_cents > ${settledCentsSubquery('i', 'invoice_id')}::bigint AND i.due_date < ${p}::date`,
      today(),
    );
  } else if (options.settlement === 'PAID') {
    clauses.push(`i.status = 'ISSUED' AND i.total_cents <= ${settledCentsSubquery('i', 'invoice_id')}::bigint`);
  }
  if (options.q !== null)
    add(
      (p) =>
        `(i.invoice_number ILIKE '%' || ${p} || '%' OR i.customer_name_snapshot ILIKE '%' || ${p} || '%')`,
      options.q,
    );

  return { where: clauses.join(' AND '), values };
}

/**
 * The chosen column, then `created_at`/`id` as tiebreakers so two rows with the
 * same value can never swap between pages. NULLS LAST keeps drafts (no number
 * yet) at the end in either direction.
 */
function invoiceOrderBy(options: ListInvoicesOptions): string {
  const sort = options.sort ?? { key: 'issueDate', direction: 'desc' };
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  return `${INVOICE_SORT_COLUMNS[sort.key]} ${direction} NULLS LAST, i.created_at DESC, i.id DESC`;
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
      ORDER BY ${invoiceOrderBy(options)}
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
export async function assertRevenueAccounts(
  client: PoolClient,
  orgId: string,
  accountIds: string[],
  allowAccountId: string | null = null,
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
  const wrongType = rows.find((row) => row.type !== 'Revenue' && row.id !== allowAccountId);
  if (wrongType !== undefined) {
    throw new ApiError(422, `Account ${wrongType.code} is not a Revenue account`);
  }
}

type LineTotal = DocumentLineTotal<InvoiceLineInput>;

function validateInvoiceInput(input: CreateInvoiceInput): void {
  if (input.lines.length === 0) {
    throw new ApiError(422, 'An invoice needs at least one line');
  }
}

/** Due-date resolution needs the transaction client (a term lookup), so it
 * cannot run inside the synchronous validateInvoiceInput above — this runs
 * once the client is open, and re-checks the same ordering invariant against
 * the resolved date. */
async function resolveInvoiceDueDate(
  client: PoolClient,
  orgId: string,
  input: Pick<CreateInvoiceInput, 'customerId' | 'issueDate' | 'dueDate' | 'paymentTermsCode' | 'paymentTerms'>,
): Promise<{ dueDate: string; paymentTerms: string | null; paymentTermsCode: string | null }> {
  let termCode = input.paymentTermsCode;
  if (input.dueDate === undefined && termCode === null) {
    termCode = await paymentTermService.resolveDefaultTermCodeOnClient(client, orgId, 'SALES', input.customerId);
  }
  const resolved = await paymentTermService.resolveDueDate(
    client,
    orgId,
    input.issueDate,
    termCode,
    input.dueDate,
  );
  if (resolved.dueDate < input.issueDate) {
    throw new ApiError(422, 'Due date cannot be before the issue date');
  }
  return {
    dueDate: resolved.dueDate,
    paymentTerms: input.paymentTerms ?? resolved.paymentTermsLabel,
    paymentTermsCode: resolved.paymentTermsCode,
  };
}

async function insertInvoiceLines(
  client: PoolClient,
  orgId: string,
  invoiceId: string,
  totals: LineTotal[],
  /** Phase 40 — per line, the description as written when filling changed it. */
  descriptionTemplates: (string | null)[] = [],
): Promise<void> {
  // Phase 32: early feedback for lot/serial items, fixed assets and a location on a
  // non-stock line (posting re-checks). The revenue account stays whatever the line carries.
  await prepareStockLinesOnClient(
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
    `INSERT INTO invoice_lines
       (org_id, invoice_id, line_number, description, quantity_milli, unit_price_cents,
        revenue_account_id, tax_rate_bp, net_cents, tax_cents, item_id, stock_location_id,
        description_template, order_line_id)
     SELECT $1, $2, v.line_number, v.description, v.quantity_milli, v.unit_price_cents,
            v.revenue_account_id, v.tax_rate_bp, v.net_cents, v.tax_cents, v.item_id, v.stock_location_id,
            v.description_template, v.order_line_id
       FROM unnest(
              $3::smallint[], $4::text[], $5::bigint[], $6::bigint[],
              $7::uuid[], $8::int[], $9::bigint[], $10::bigint[], $11::uuid[], $12::uuid[], $13::text[],
              $14::uuid[]
            ) AS v(line_number, description, quantity_milli, unit_price_cents,
                    revenue_account_id, tax_rate_bp, net_cents, tax_cents, item_id, stock_location_id,
                    description_template, order_line_id)`,
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
      totals.map((t) => t.input.itemId),
      totals.map((t) => t.input.stockLocationId ?? null),
      totals.map((_, i) => descriptionTemplates[i] ?? null),
      totals.map((t) => t.input.orderLineId ?? null),
    ],
  );
}

/**
 * Phase 40 — fills an invoice's user-authored text: its notes and each line's
 * description. Payment terms are a catalogue label, and the journal entry's
 * description is system text, so neither is ever filled.
 */
function fillInvoiceText(
  notes: string | null,
  descriptions: string[],
  ctx: PlaceholderContext,
  mode: FillMode,
): { notes: { text: string | null; template: string | null }; lines: { text: string; template: string | null }[] } {
  return {
    notes: fillOptionalField(notes, 'INVOICE', ctx, mode, { label: 'Notes', max: NOTES_MAX }),
    lines: descriptions.map((description, i) =>
      fillField(description, 'INVOICE', ctx, mode, {
        label: `Line ${String(i + 1)}'s description`,
        max: LINE_DESCRIPTION_MAX,
        required: true,
      }),
    ),
  };
}

export interface CreateInvoiceOptions {
  /** Import only: stored on the draft; issue uses it instead of allocating. Never exposed in invoiceSchema. */
  invoiceNumber?: string;
  /** Import conversion mode only: this one account id (3400) is accepted by assertRevenueAccounts as if it were Revenue. */
  equityAccountId?: string;
  /**
   * Phase 40 — recurring generation only: fill the notes' and lines'
   * placeholders now, against the issue date and this run's number, keeping
   * any that have no value yet (`[Invoice Number]`) for issue. A hand-saved
   * draft is stored as typed instead, so editing it never loses a placeholder.
   */
  placeholders?: { occurrence: number };
  /** Phase 41 — quote conversion only: the accepted SALES quote this draft comes from. Never exposed in invoiceSchema. */
  sourceQuoteId?: string;
  /**
   * Phase 42 — `depositService.createDepositDocument` only: makes this a
   * `kind = 'DEPOSIT'` invoice for that order. Its single line is on the
   * customer-deposit (Liability) account, which assertRevenueAccounts accepts
   * as if it were Revenue; depositService has already validated that account.
   * Never exposed in invoiceSchema.
   */
  depositForOrderId?: string;
}

/**
 * Phase 34b — the core of `createInvoice`, runnable on a caller's own
 * transaction client (e.g. `recurringService.runDueOccurrences`). Runs no
 * BEGIN/COMMIT/ROLLBACK and maps no errors (rule 5) — the caller owns both.
 * Includes `validateInvoiceInput`/`computeLineTotals` so a caller cannot skip
 * validation. Returns the new invoice's id.
 */
export async function createInvoiceOnClient(
  client: PoolClient,
  orgId: string,
  createdBy: string,
  input: CreateInvoiceInput,
  options: CreateInvoiceOptions = {},
): Promise<string> {
  validateInvoiceInput(input);
  let totals = computeLineTotals(input.lines);
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;

  const { rows: orgRows } = await client.query<{ name: string; base_currency: string }>(
    'SELECT name, base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
  const currencyCode = input.currencyCode ?? baseCurrency;

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

  const resolvedDue = await resolveInvoiceDueDate(client, orgId, input);

  if (input.salesOrderId !== undefined && input.salesOrderId !== null) {
    await assertOrderReferenceOnClient(client, orgId, 'SALES', input.customerId, input.salesOrderId);
  }

  let notes = input.notes;
  let notesTemplate: string | null = null;
  let descriptionTemplates: (string | null)[] = [];
  if (options.placeholders !== undefined) {
    const ctx: PlaceholderContext = {
      date: input.issueDate,
      dueDate: resolvedDue.dueDate,
      contactName: customer.name,
      organisationName: orgRows[0]?.name ?? null,
      occurrence: options.placeholders.occurrence,
    };
    const filled = fillInvoiceText(input.notes, totals.map((t) => t.input.description), ctx, 'partial');
    notes = filled.notes.text;
    notesTemplate = filled.notes.template;
    descriptionTemplates = filled.lines.map((l) => l.template);
    totals = totals.map((t, i) => ({ ...t, input: { ...t.input, description: filled.lines[i]?.text ?? t.input.description } }));
  }

  await assertRevenueAccounts(
    client,
    orgId,
    totals.map((t) => t.input.revenueAccountId),
    options.equityAccountId ??
      (options.depositForOrderId === undefined ? null : (totals[0]?.input.revenueAccountId ?? null)),
  );

  // Resolved on every draft save so the draft always displays an honest
  // base-currency total; frozen for good at issueInvoice.
  const fxRate = await fxRateService.documentRateOnClient(client, orgId, currencyCode, baseCurrency, input.issueDate);
  const baseSubtotalCents = convertToBase(subtotalCents, fxRate);
  const baseTaxCents = convertToBase(taxCents, fxRate);
  const baseTotalCents = baseSubtotalCents + baseTaxCents;

  const { rows: invoiceRows } = await client.query<{ id: string }>(
    `INSERT INTO invoices
       (org_id, customer_id, issue_date, due_date, currency_code,
        customer_name_snapshot, customer_address_snapshot, customer_tax_number_snapshot,
        notes, payment_terms, payment_terms_code, subtotal_cents, tax_cents, total_cents,
        fx_rate, base_subtotal_cents, base_tax_cents, base_total_cents, created_by, invoice_number,
        notes_template, source_quote_id, source_quote_direction, kind, deposit_for_order_id, sales_order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             $22, $23, $24, $25, $26)
     RETURNING id`,
    [
      orgId,
      input.customerId,
      input.issueDate,
      resolvedDue.dueDate,
      currencyCode,
      customer.name,
      customer.billing_address,
      customer.tax_number,
      notes,
      resolvedDue.paymentTerms,
      resolvedDue.paymentTermsCode,
      subtotalCents,
      taxCents,
      totalCents,
      fxRate,
      baseSubtotalCents,
      baseTaxCents,
      baseTotalCents,
      createdBy,
      options.invoiceNumber ?? null,
      notesTemplate,
      options.sourceQuoteId ?? null,
      options.sourceQuoteId === undefined ? null : 'SALES',
      options.depositForOrderId === undefined ? 'STANDARD' : 'DEPOSIT',
      options.depositForOrderId ?? null,
      input.salesOrderId ?? null,
    ],
  );
  const invoiceId = invoiceRows[0]?.id;
  if (invoiceId === undefined) throw new Error('INSERT ... RETURNING produced no row');

  await assertOrderLineLinksOnClient(
    client,
    orgId,
    'SALES',
    input.customerId,
    currencyCode,
    totals.flatMap((t) => (t.input.orderLineId ? [t.input.orderLineId] : [])),
  );
  await insertInvoiceLines(client, orgId, invoiceId, totals, descriptionTemplates);

  if (input.attachmentDocumentIds !== undefined && input.attachmentDocumentIds.length > 0) {
    await documentService.attachDocumentsOnClient(client, orgId, createdBy, input.attachmentDocumentIds, {
      module: MODULE_TAGS.accounting,
      entityType: 'invoice',
      entityId: invoiceId,
    });
  }

  return invoiceId;
}

/** Import only: which of an import's invoice numbers already exist in this org (rule 1). */
export async function findExistingInvoiceNumbersOnClient(
  client: PoolClient,
  orgId: string,
  numbers: readonly string[],
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const { rows } = await client.query<{ invoice_number: string }>(
    'SELECT invoice_number FROM invoices WHERE org_id = $1 AND invoice_number = ANY($2::text[])',
    [orgId, [...numbers]],
  );
  return new Set(rows.map((r) => r.invoice_number));
}

export async function createInvoice(
  orgId: string,
  createdBy: string,
  input: CreateInvoiceInput,
): Promise<Invoice> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const invoiceId = await createInvoiceOnClient(client, orgId, createdBy, input);

    await client.query('COMMIT');
    return await getInvoiceById(orgId, invoiceId);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
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

/** A draft edit replaces the whole document — the document is small and the client carries no line identity to diff against. */
export async function updateInvoice(
  orgId: string,
  id: string,
  input: UpdateInvoiceInput,
  userId: string,
): Promise<Invoice> {
  validateInvoiceInput(input);
  const totals = computeLineTotals(input.lines);
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  const totalCents = subtotalCents + taxCents;

  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: statusRows } = await client.query<{ status: string; kind: string }>(
      'SELECT status, kind FROM invoices WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const statusRow = statusRows[0];
    if (statusRow === undefined) throw new ApiError(404, 'Invoice not found');
    if (statusRow.status !== 'DRAFT') {
      throw new ApiError(409, 'Only a draft invoice can be edited');
    }
    if (statusRow.kind === 'DEPOSIT') {
      throw new ApiError(409, 'A deposit invoice cannot be edited. Delete it and request a new deposit from the order.');
    }

    const { rows: orgRows } = await client.query<{ base_currency: string }>(
      'SELECT base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const baseCurrency = orgRows[0]?.base_currency.trim();
    if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
    const currencyCode = input.currencyCode ?? baseCurrency;

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

    const resolvedDue = await resolveInvoiceDueDate(client, orgId, input);

    if (input.salesOrderId !== undefined && input.salesOrderId !== null) {
      await assertOrderReferenceOnClient(client, orgId, 'SALES', input.customerId, input.salesOrderId);
    }

    await assertRevenueAccounts(
      client,
      orgId,
      totals.map((t) => t.input.revenueAccountId),
    );

    const fxRate = await fxRateService.documentRateOnClient(client, orgId, currencyCode, baseCurrency, input.issueDate);
    const baseSubtotalCents = convertToBase(subtotalCents, fxRate);
    const baseTaxCents = convertToBase(taxCents, fxRate);
    const baseTotalCents = baseSubtotalCents + baseTaxCents;

    await client.query('DELETE FROM invoice_lines WHERE invoice_id = $1 AND org_id = $2', [
      id,
      orgId,
    ]);

    await client.query(
      `UPDATE invoices
          SET customer_id = $1, issue_date = $2, due_date = $3, currency_code = $4,
              customer_name_snapshot = $5, customer_address_snapshot = $6,
              customer_tax_number_snapshot = $7, notes = $8, payment_terms = $9, payment_terms_code = $10,
              subtotal_cents = $11, tax_cents = $12, total_cents = $13,
              fx_rate = $14, base_subtotal_cents = $15, base_tax_cents = $16, base_total_cents = $17,
              notes_template = NULL
        WHERE id = $18 AND org_id = $19`,
      [
        input.customerId,
        input.issueDate,
        resolvedDue.dueDate,
        currencyCode,
        customer.name,
        customer.billing_address,
        customer.tax_number,
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

    await assertOrderLineLinksOnClient(
      client,
      orgId,
      'SALES',
      input.customerId,
      currencyCode,
      totals.flatMap((t) => (t.input.orderLineId ? [t.input.orderLineId] : [])),
    );
    await insertInvoiceLines(client, orgId, id, totals);

    // Phase 43b — undefined leaves the order link alone, null clears it.
    if (input.salesOrderId !== undefined) {
      await client.query('UPDATE invoices SET sales_order_id = $1 WHERE id = $2 AND org_id = $3', [
        input.salesOrderId,
        id,
        orgId,
      ]);
    }
    if (input.attachmentDocumentIds !== undefined && input.attachmentDocumentIds.length > 0) {
      await documentService.attachDocumentsOnClient(client, orgId, userId, input.attachmentDocumentIds, {
        module: MODULE_TAGS.accounting,
        entityType: 'invoice',
        entityId: id,
      });
    }

    await client.query('COMMIT');
    return await getInvoiceById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
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

export async function deleteInvoice(orgId: string, id: string): Promise<void> {
  const { rows } = await withTransaction(async (client) => {
    const deleted = await client.query<{ id: string; source_quote_id: string | null }>(
      `DELETE FROM invoices WHERE id = $1 AND org_id = $2 AND status = 'DRAFT' RETURNING id, source_quote_id`,
      [id, orgId],
    );
    // Phase 41 — a deleted draft frees the quote it was converted from.
    await revertConversionOnClient(client, orgId, deleted.rows[0]?.source_quote_id ?? null);
    return deleted;
  });

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
export async function resolvePostingAccounts(
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

/**
 * Phase 34b — the core of `issueInvoice`, runnable on a caller's own
 * transaction client (e.g. `recurringService.runDueOccurrences`). Runs no
 * BEGIN/COMMIT/ROLLBACK and maps no errors (rule 5) — the caller owns both.
 */
export interface IssueInvoiceOptions {
  /**
   * Phase 40 — fill the notes' and lines' placeholders as the invoice is
   * issued (default). Imports pass false: their text is historical data,
   * not placeholder-authored.
   */
  fillPlaceholders?: boolean;
}

export async function issueInvoiceOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
  options: IssueInvoiceOptions = {},
): Promise<void> {
    const { rows: invoiceRows } = await client.query<{
      id: string;
      status: string;
      issue_date: string;
      due_date: string;
      customer_id: string;
      customer_name_snapshot: string;
      currency_code: string;
      subtotal_cents: string;
      total_cents: string;
      tax_cents: string;
      invoice_number: string | null;
      notes: string | null;
    }>(
      `SELECT id, status, issue_date, due_date, customer_id, customer_name_snapshot,
              currency_code, subtotal_cents, total_cents, tax_cents, invoice_number, notes
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
      id: string;
      line_number: number;
      description: string;
      quantity_milli: string;
      revenue_account_id: string;
      net_cents: string;
      item_id: string | null;
      stock_location_id: string | null;
    }>(
      `SELECT id, line_number, description, quantity_milli, revenue_account_id, net_cents, item_id, stock_location_id
         FROM invoice_lines WHERE invoice_id = $1 AND org_id = $2 ORDER BY line_number`,
      [id, orgId],
    );
    if (lineRows.length === 0) {
      throw new ApiError(422, 'An invoice needs at least one line before it can be issued');
    }

    const totalCents = parseCents(invoiceRow.total_cents);
    const subtotalCents = parseCents(invoiceRow.subtotal_cents);
    const taxTotalCents = parseCents(invoiceRow.tax_cents);
    const documentCurrency = invoiceRow.currency_code.trim();
    const postingDate = entryDate ?? invoiceRow.issue_date;

    // The rate is frozen HERE, at posting, re-resolved for the posting date
    // rather than trusting whatever the draft last saved for issue_date —
    // entryDate can differ from issue_date. Once issued this never changes
    // again; every later settlement compares its own rate against this one.
    const { rows: orgRows } = await client.query<{ name: string; base_currency: string }>(
      'SELECT name, base_currency FROM organizations WHERE id = $1',
      [orgId],
    );
    const baseCurrency = orgRows[0]?.base_currency.trim();
    if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
    const fxRate = await fxRateService.documentRateOnClient(client, orgId, documentCurrency, baseCurrency, postingDate);
    const baseSubtotalCents = convertToBase(subtotalCents, fxRate);
    const baseTaxCents = convertToBase(taxTotalCents, fxRate);
    const baseTotalCents = baseSubtotalCents + baseTaxCents;

    const { receivableAccountId, taxAccountId } = await resolvePostingAccounts(
      client,
      orgId,
      taxTotalCents > 0,
    );

    // Phase 32 — INVENTORY lines issue stock at the current moving average, in
    // BASE currency. Done before the invoice number is allocated so a 409 for
    // short stock leaves the invoice a DRAFT with no number consumed (lock
    // order: invoice row -> stock balances -> number counter -> journal).
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
    const stockIssue =
      stockLines.size === 0
        ? null
        : await documentStockService.issueForDocumentOnClient(client, orgId, userId, {
            sourceType: 'invoice',
            sourceId: id,
            occurredOn: postingDate,
            reference: null,
            lines: [...stockLines.values()].map((l) => ({
              lineNumber: l.lineNumber,
              ledgerItemId: l.itemId,
              locationId: l.stockLocationId,
              quantityMilli: l.quantityMilli,
              glAccountId: l.accounts.assetAccountId,
            })),
          });

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

    const glLines: JournalLineInput[] = [
      { accountId: receivableAccountId, debitCents: totalCents, creditCents: 0, currencyCode: documentCurrency, fxRate },
      ...[...revenueByAccount.entries()].map(([accountId, netCents]) => ({
        accountId,
        debitCents: 0,
        creditCents: netCents,
        currencyCode: documentCurrency,
        fxRate,
      })),
    ];
    if (taxAccountId !== null && taxTotalCents > 0) {
      glLines.push({
        accountId: taxAccountId,
        debitCents: 0,
        creditCents: taxTotalCents,
        currencyCode: documentCurrency,
        fxRate,
      });
    }

    const debitTotal = sumCents(glLines.map((l) => cents(l.debitCents)));
    const creditTotal = sumCents(glLines.map((l) => cents(l.creditCents)));
    if (debitTotal !== creditTotal) {
      // A bug, not user input — the invariant that totalCents = subtotal + tax
      // and that line net/tax sum to those totals should make this impossible.
      throw new Error('Invoice posting is unbalanced');
    }

    // Cost of sales: Dr COGS / Cr Inventory at the value Inventory just removed,
    // in the SAME entry as the sale. BASE currency (no currencyCode) — inventory
    // value is always base — appended after the native-currency balance check
    // above because a foreign-currency invoice legitimately mixes currencies
    // (createEntryOnClient balances base amounts; the pair balances on its own).
    if (stockIssue !== null) {
      const cogsByAccount = new Map<string, number>();
      const inventoryByAccount = new Map<string, number>();
      for (const issued of stockIssue.lines) {
        const line = stockLines.get(issued.lineNumber);
        if (line === undefined || issued.valueCents === 0) continue;
        const cogsAccountId = line.accounts.cogsAccountId;
        cogsByAccount.set(cogsAccountId, (cogsByAccount.get(cogsAccountId) ?? 0) + issued.valueCents);
        inventoryByAccount.set(issued.glAccountId, (inventoryByAccount.get(issued.glAccountId) ?? 0) + issued.valueCents);
      }
      for (const [accountId, value] of cogsByAccount) glLines.push({ accountId, debitCents: value, creditCents: 0 });
      for (const [accountId, value] of inventoryByAccount) glLines.push({ accountId, debitCents: 0, creditCents: value });
    }

    const invoiceNumber = invoiceRow.invoice_number ?? await invoiceSettingsService.allocateInvoiceNumber(client, orgId);

    // Phase 40 — no placeholder reaches an issued invoice. Filled after the
    // number is allocated (so [Invoice Number] has its value) and in the same
    // transaction, so an over-long result (422) also rolls the number back.
    // ORDER MATTERS: lines are updated while the invoice is still DRAFT —
    // trg_invoice_lines_draft_only reads the parent's status — while the
    // notes ride on the status flip below, which trg_invoices_immutable
    // allows because OLD.status is still DRAFT.
    let notes = invoiceRow.notes;
    let notesTemplate: string | null = null;
    if (options.fillPlaceholders !== false) {
      const filled = fillInvoiceText(
        invoiceRow.notes,
        lineRows.map((l) => l.description),
        {
          date: invoiceRow.issue_date,
          dueDate: invoiceRow.due_date,
          contactName: invoiceRow.customer_name_snapshot,
          organisationName: orgRows[0]?.name ?? null,
          invoiceNumber,
        },
        'final',
      );
      notes = filled.notes.text;
      notesTemplate = filled.notes.template;
      const changed = lineRows.flatMap((l, i) => {
        const line = filled.lines[i];
        return line === undefined || line.template === null ? [] : [{ id: l.id, text: line.text, template: line.template }];
      });
      if (changed.length > 0) {
        await client.query(
          `UPDATE invoice_lines l
              SET description = v.description,
                  description_template = COALESCE(l.description_template, v.description_template)
             FROM unnest($3::uuid[], $4::text[], $5::text[]) AS v(id, description, description_template)
            WHERE l.id = v.id AND l.org_id = $1 AND l.invoice_id = $2`,
          [orgId, id, changed.map((c) => c.id), changed.map((c) => c.text), changed.map((c) => c.template)],
        );
      }
    }

    const journalEntryId = await journalService.createEntryOnClient(client, orgId, userId, {
      entryDate: postingDate,
      description: `Invoice ${invoiceNumber} — ${invoiceRow.customer_name_snapshot}`,
      sourceType: 'invoice',
      sourceId: id,
      lines: glLines,
    });

    await client.query(
      `UPDATE invoices
          SET status = 'ISSUED', invoice_number = $1, journal_entry_id = $2, issued_at = now(),
              fx_rate = $3, base_subtotal_cents = $4, base_tax_cents = $5, base_total_cents = $6,
              notes = $9, notes_template = COALESCE(notes_template, $10)
        WHERE id = $7 AND org_id = $8`,
      [invoiceNumber, journalEntryId, fxRate, baseSubtotalCents, baseTaxCents, baseTotalCents, id, orgId, notes, notesTemplate],
    );

    await emitEvent(client, orgId, MODULE_TAGS.accounting, 'invoice.issued', {
      invoiceId: invoiceRow.id,
      invoiceNumber,
      customerId: invoiceRow.customer_id,
      customerName: invoiceRow.customer_name_snapshot,
      issueDate: invoiceRow.issue_date,
      dueDate: invoiceRow.due_date,
      currencyCode: invoiceRow.currency_code,
      subtotalCents: parseCents(invoiceRow.subtotal_cents),
      taxCents: taxTotalCents,
      totalCents: totalCents,
      fxRate,
      baseTotalCents,
      journalEntryId,
    });
}

export async function issueInvoice(
  orgId: string,
  userId: string,
  id: string,
  entryDate: string | null,
  applyCredits: readonly ApplyCreditInput[] = [],
): Promise<Invoice> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await issueInvoiceOnClient(client, orgId, userId, id, entryDate);
    // Phase 43c — same transaction: a rejected credit rolls the issue back.
    await applyCreditsOnClient(client, orgId, userId, 'SALES', id, applyCredits);
    await client.query('COMMIT');
    return await getInvoiceById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_DEADLOCK_DETECTED) {
      throw new ApiError(409, 'Another change to these documents was in progress — try again');
    }
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

      // Phase 26 — an invoice that a credit note corrects (or that a credit
      // was applied to) cannot disappear from under that note.
      const { rows: noteRows } = await client.query<{ has_notes: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM credit_notes WHERE org_id = $1 AND invoice_id = $2 AND status = 'ISSUED')
             OR EXISTS (SELECT 1 FROM credit_note_allocations a
                          JOIN credit_notes n ON n.id = a.credit_note_id AND n.org_id = a.org_id
                         WHERE a.org_id = $1 AND a.invoice_id = $2 AND n.status = 'ISSUED') AS has_notes`,
        [orgId, id],
      );
      if (noteRows[0]?.has_notes === true) {
        throw new ApiError(409, 'This invoice has credit notes. Void the credit notes first.');
      }

      // Phase 42 — an invoice that took a deposit, or that is the deposit,
      // cannot disappear from under a POSTED application.
      if (await hasPostedDepositApplicationsOnClient(client, orgId, 'invoice', id)) {
        throw new ApiError(409, 'Void the deposit applications on this invoice first');
      }
    }

    if (row.status === 'ISSUED') {
      if (row.journal_entry_id === null) {
        throw new Error(`Issued invoice ${id} has no journal_entry_id`);
      }
      // Phase 35a lock order: resolve the products' CURRENT accounts before
      // any stock balance is locked by the reversal below.
      const ledgerItemIds = await documentStockService.listDocumentLedgerItemIdsOnClient(client, orgId, 'invoice', id);
      const stockTargets = await resolveStockAccountsOnClient(client, orgId, ledgerItemIds);

      // Phase 32: stock comes back at the EXACT value it left at (the reversing
      // entry below already mirrors the COGS lines), so no variance is possible.
      const stockReversal = await documentStockService.reverseDocumentOnClient(client, orgId, userId, {
        sourceType: 'invoice',
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
      // Phase 35a: sweep the reversal's value onto each product's current
      // inventory account (it may have changed since the invoice was issued).
      await inventoryAccountingService.sweepVoidOnClient(
        client,
        orgId,
        userId,
        stockReversal,
        stockTargets,
        'Void — stock value returned to the current inventory account',
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
