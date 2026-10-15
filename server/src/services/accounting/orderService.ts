import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { MODULE_TAGS } from '../../config/modules.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { computeLineTotals, sumDocumentTotals, type LineTotal } from '../../utils/documentTotals.js';
import { emitEvent } from '../outboxService.js';
import { prepareStockLinesOnClient } from './documentStockLines.js';
import * as invoiceService from './invoiceService.js';
import * as billService from './billService.js';
import * as depositService from './depositService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import * as paymentTermService from './paymentTermService.js';
import { orgTodayOnClient } from './settingsService.js';
import {
  canTransitionOrder,
  type Order,
  type OrderBillingStatus,
  type OrderLine,
  type OrderStatus,
  type OrderSummary,
  type Quote,
  type QuoteDirection,
  ORDER_STATUSES,
} from '../../types/accounting.js';

/**
 * Phase 42 — sales and purchase orders.
 *
 * An order is a commitment, not an accounting event: nothing in this file
 * writes `journal_entries`, `ledger_lines` or stock movements. Revenue (or
 * expense) is recognised on the invoice (or bill) raised *against* the order,
 * which may bill only part of each line — `invoice_lines.order_line_id` /
 * `bill_lines.order_line_id` link a document line to the order line it bills.
 *
 * The billed quantity of an order line is never stored: it is the sum of the
 * linked lines on non-VOID documents, so voiding or deleting a document frees
 * its quantity with no bookkeeping. The invariant billed ≤ ordered is held by
 * migration 092's deferred constraint trigger at COMMIT; this file reads the
 * same sums to show "remaining" and to refuse an over-ask with a precise
 * message before the database has to.
 *
 * Lifecycle (ORDER_TRANSITIONS): DRAFT is freely editable and deletable.
 * Confirming allocates a gapless number, re-snapshots the party and freezes
 * the row (migration 092's trigger). `transitionOrderOnClient` is the only
 * writer of `status` (rule 10).
 *
 * `direction` always comes from the route (`/orders` = SALES,
 * `/purchase-orders` = PURCHASE) and every query filters on it, so a sales
 * order id is a 404 on the purchase routes and vice versa.
 */

type Queryable = Pick<PoolClient, 'query'>;

const PG_RAISE_EXCEPTION = 'P0001';
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_FEATURE_NOT_SUPPORTED = '0A000';

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
    return typeof err.message === 'string' ? err.message : 'Database rejected the order';
  }
  return 'Database rejected the order';
}

/** The party table and label per direction. Identifiers come only from here (rule 4). */
const PARTY = {
  SALES: { table: 'customers', column: 'customer_id', label: 'Customer' },
  PURCHASE: { table: 'vendors', column: 'vendor_id', label: 'Vendor' },
} as const;

// --------------------------------------------------------------------- inputs

export interface OrderLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  accountId: string;
  taxRateBp: number;
  itemId: string | null;
}

export interface CreateOrderInput {
  partyId: string;
  orderDate: string;
  expectedDate: string | null;
  currencyCode?: string | undefined;
  partyReference: string | null;
  notes: string | null;
  terms: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  lines: OrderLineInput[];
}

export type UpdateOrderInput = CreateOrderInput;

export interface ConvertOrderInput {
  documentDate: string | null;
  dueDate: string | null;
  vendorReference: string | null;
  /** null = everything still unbilled. */
  lines: { orderLineId: string; quantityMilli: number }[] | null;
}

export const ORDER_SORT_KEYS = ['orderDate', 'number', 'party', 'total', 'status'] as const;
export type OrderSortKey = (typeof ORDER_SORT_KEYS)[number];
const ORDER_SORT_COLUMNS: Record<OrderSortKey, string> = {
  orderDate: 'o.order_date',
  number: 'o.order_number',
  party: 'o.party_name_snapshot',
  total: 'o.total_cents',
  status: 'o.status',
};

export interface ListOrdersOptions {
  page: number;
  limit: number;
  status: OrderStatus | null;
  partyId: string | null;
  from: string | null;
  to: string | null;
  q: string | null;
  sort?: { key: OrderSortKey; direction: 'asc' | 'desc' };
}

// ---------------------------------------------------------------- row mapping

interface OrderRow {
  id: string;
  direction: QuoteDirection;
  customer_id: string | null;
  vendor_id: string | null;
  party_name: string | null;
  order_number: string | null;
  status: string;
  order_date: string;
  expected_date: string | null;
  currency_code: string;
  party_name_snapshot: string;
  party_address_snapshot: string | null;
  party_tax_number_snapshot: string | null;
  party_reference: string | null;
  notes: string | null;
  terms: string | null;
  payment_terms: string | null;
  payment_terms_code: string | null;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  source_quote_id: string | null;
  source_quote_number: string | null;
  source_quote_revision: number | null;
  confirmed_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const ORDER_SELECT = `SELECT o.id, o.direction, o.customer_id, o.vendor_id,
                             COALESCE(c.name, v.name) AS party_name,
                             o.order_number, o.status, o.order_date::text AS order_date,
                             o.expected_date::text AS expected_date, o.currency_code,
                             o.party_name_snapshot, o.party_address_snapshot, o.party_tax_number_snapshot,
                             o.party_reference, o.notes, o.terms, o.payment_terms, o.payment_terms_code,
                             o.subtotal_cents, o.tax_cents, o.total_cents,
                             o.source_quote_id, q.quote_number AS source_quote_number,
                             q.revision AS source_quote_revision,
                             o.confirmed_at, o.closed_at, o.cancelled_at, o.cancel_reason,
                             o.created_by, u.name AS created_by_name, o.created_at, o.updated_at
                        FROM orders o
                        LEFT JOIN customers c ON c.id = o.customer_id AND c.org_id = o.org_id
                        LEFT JOIN vendors v   ON v.id = o.vendor_id   AND v.org_id = o.org_id
                        LEFT JOIN users u     ON u.id = o.created_by
                        LEFT JOIN quotes q    ON q.id = o.source_quote_id AND q.org_id = o.org_id`;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

function statusOf(row: { id: string; status: string }): OrderStatus {
  if (!isOrderStatus(row.status)) throw new Error(`Unknown order status "${row.status}" on order ${row.id}`);
  return row.status;
}

/** Derived from an order's lines: none billed, all billed, or some billed. */
function billingStatusOf(lines: readonly { orderedMilli: number; billedMilli: number }[]): OrderBillingStatus {
  if (lines.every((l) => l.billedMilli === 0)) return 'NOT_BILLED';
  if (lines.every((l) => l.billedMilli >= l.orderedMilli)) return 'FULLY_BILLED';
  return 'PARTIALLY_BILLED';
}

interface BilledRow {
  id: string;
  order_id: string;
  quantity_milli: string;
  billed_milli: string;
}

/**
 * The ordered and billed quantity of every line of the given orders, in one
 * grouped query. Billed = Σ linked invoice lines on non-VOID invoices + Σ
 * linked bill lines on non-VOID bills — the same sums migration 092's cap
 * trigger evaluates.
 */
async function loadBilledOnClient(q: Queryable, orgId: string, orderIds: string[]): Promise<BilledRow[]> {
  if (orderIds.length === 0) return [];
  const { rows } = await q.query<BilledRow>(
    `SELECT ol.id, ol.order_id, ol.quantity_milli,
            (
              COALESCE((SELECT SUM(il.quantity_milli)
                          FROM invoice_lines il
                          JOIN invoices i ON i.org_id = il.org_id AND i.id = il.invoice_id
                         WHERE il.org_id = ol.org_id AND il.order_line_id = ol.id AND i.status <> 'VOID'), 0)
              +
              COALESCE((SELECT SUM(bl.quantity_milli)
                          FROM bill_lines bl
                          JOIN bills b ON b.org_id = bl.org_id AND b.id = bl.bill_id
                         WHERE bl.org_id = ol.org_id AND bl.order_line_id = ol.id AND b.status <> 'VOID'), 0)
            )::bigint AS billed_milli
       FROM order_lines ol
      WHERE ol.org_id = $1 AND ol.order_id = ANY($2::uuid[])`,
    [orgId, orderIds],
  );
  return rows;
}

function toSummary(row: OrderRow, billingStatus: OrderBillingStatus): OrderSummary {
  return {
    id: row.id,
    direction: row.direction,
    orderNumber: row.order_number,
    status: statusOf(row),
    billingStatus,
    partyId: row.customer_id ?? row.vendor_id ?? '',
    partyName: row.party_name ?? row.party_name_snapshot,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    currencyCode: row.currency_code.trim(),
    totalCents: parseCents(row.total_cents),
    createdAt: row.created_at.toISOString(),
  };
}

interface OrderLineRow {
  id: string;
  line_number: number;
  description: string;
  quantity_milli: string;
  unit_price_cents: string;
  account_id: string;
  account_code: string;
  account_name: string;
  tax_rate_bp: number;
  net_cents: string;
  tax_cents: string;
  item_id: string | null;
}

async function loadLines(q: Queryable, orgId: string, orderId: string): Promise<OrderLine[]> {
  const { rows } = await q.query<OrderLineRow>(
    `SELECT l.id, l.line_number, l.description, l.quantity_milli, l.unit_price_cents,
            l.account_id, a.code AS account_code, a.name AS account_name,
            l.tax_rate_bp, l.net_cents, l.tax_cents, l.item_id
       FROM order_lines l
       JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1 AND l.order_id = $2
      ORDER BY l.line_number ASC`,
    [orgId, orderId],
  );
  const billed = new Map((await loadBilledOnClient(q, orgId, [orderId])).map((b) => [b.id, Number(b.billed_milli)]));
  return rows.map((r) => {
    const ordered = Number(r.quantity_milli);
    const billedMilli = billed.get(r.id) ?? 0;
    return {
      id: r.id,
      lineNumber: r.line_number,
      description: r.description,
      quantityMilli: ordered,
      unitPriceCents: parseCents(r.unit_price_cents),
      accountId: r.account_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      taxRateBp: r.tax_rate_bp,
      netCents: parseCents(r.net_cents),
      taxCents: parseCents(r.tax_cents),
      itemId: r.item_id,
      billedQuantityMilli: billedMilli,
      remainingQuantityMilli: Math.max(0, ordered - billedMilli),
    };
  });
}

async function loadDocuments(q: Queryable, orgId: string, orderId: string): Promise<Order['documents']> {
  const { rows: invoices } = await q.query<{ id: string; invoice_number: string | null; status: string; total_cents: string }>(
    `SELECT i.id, i.invoice_number, i.status, i.total_cents
       FROM invoices i
      WHERE i.org_id = $1
        AND (EXISTS (SELECT 1
                       FROM invoice_lines il
                       JOIN order_lines ol ON ol.org_id = il.org_id AND ol.id = il.order_line_id
                      WHERE il.org_id = i.org_id AND il.invoice_id = i.id AND ol.order_id = $2)
             OR i.deposit_for_order_id = $2)
      ORDER BY i.created_at ASC, i.id ASC`,
    [orgId, orderId],
  );
  const { rows: bills } = await q.query<{ id: string; vendor_reference: string; status: string; total_cents: string }>(
    `SELECT b.id, b.vendor_reference, b.status, b.total_cents
       FROM bills b
      WHERE b.org_id = $1
        AND (EXISTS (SELECT 1
                       FROM bill_lines bl
                       JOIN order_lines ol ON ol.org_id = bl.org_id AND ol.id = bl.order_line_id
                      WHERE bl.org_id = b.org_id AND bl.bill_id = b.id AND ol.order_id = $2)
             OR b.deposit_for_order_id = $2)
      ORDER BY b.created_at ASC, b.id ASC`,
    [orgId, orderId],
  );
  return [
    ...invoices.map((r) => ({
      kind: 'INVOICE' as const,
      id: r.id,
      number: r.invoice_number,
      status: r.status,
      totalCents: parseCents(r.total_cents),
    })),
    ...bills.map((r) => ({
      kind: 'BILL' as const,
      id: r.id,
      number: r.vendor_reference,
      status: r.status,
      totalCents: parseCents(r.total_cents),
    })),
  ];
}

async function loadOrder(q: Queryable, orgId: string, direction: QuoteDirection, id: string): Promise<Order> {
  const { rows } = await q.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1 AND o.org_id = $2 AND o.direction = $3`, [
    id,
    orgId,
    direction,
  ]);
  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Order not found');

  // Sequential: `q` may be a transaction client (pg forbids overlapping queries on one).
  const lines = await loadLines(q, orgId, row.id);
  const documents = await loadDocuments(q, orgId, row.id);
  const billing = billingStatusOf(
    lines.map((l) => ({ orderedMilli: l.quantityMilli, billedMilli: l.billedQuantityMilli })),
  );

  return {
    ...toSummary(row, billing),
    partyNameSnapshot: row.party_name_snapshot,
    partyAddressSnapshot: row.party_address_snapshot,
    partyTaxNumberSnapshot: row.party_tax_number_snapshot,
    partyReference: row.party_reference,
    notes: row.notes,
    terms: row.terms,
    paymentTerms: row.payment_terms,
    paymentTermsCode: row.payment_terms_code,
    subtotalCents: parseCents(row.subtotal_cents),
    taxCents: parseCents(row.tax_cents),
    sourceQuote:
      row.source_quote_id === null || row.source_quote_number === null || row.source_quote_revision === null
        ? null
        : { id: row.source_quote_id, quoteNumber: row.source_quote_number, revision: row.source_quote_revision },
    confirmedAt: iso(row.confirmed_at),
    closedAt: iso(row.closed_at),
    cancelledAt: iso(row.cancelled_at),
    cancelReason: row.cancel_reason,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at.toISOString(),
    lines,
    documents,
  };
}

// ---------------------------------------------------------------------- reads

export async function getOrderById(orgId: string, direction: QuoteDirection, id: string): Promise<Order> {
  return loadOrder(pool, orgId, direction, id);
}

function buildFilters(
  orgId: string,
  direction: QuoteDirection,
  options: ListOrdersOptions,
): { where: string; values: unknown[] } {
  const clauses = ['o.org_id = $1', 'o.direction = $2'];
  const values: unknown[] = [orgId, direction];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  if (options.status !== null) add((p) => `o.status = ${p}`, options.status);
  if (options.partyId !== null) {
    // The column name is one of PARTY's two constants (rule 4).
    add((p) => `o.${PARTY[direction].column} = ${p}::uuid`, options.partyId);
  }
  if (options.from !== null) add((p) => `o.order_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `o.order_date <= ${p}::date`, options.to);
  if (options.q !== null) {
    add(
      (p) =>
        `(o.order_number ILIKE '%' || ${p} || '%' OR o.party_name_snapshot ILIKE '%' || ${p} || '%'
          OR o.party_reference ILIKE '%' || ${p} || '%')`,
      options.q,
    );
  }
  return { where: clauses.join(' AND '), values };
}

export async function listOrders(
  orgId: string,
  direction: QuoteDirection,
  options: ListOrdersOptions,
): Promise<{ orders: OrderSummary[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const { where, values } = buildFilters(orgId, direction, options);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM orders o WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  const sort = options.sort ?? { key: 'orderDate', direction: 'desc' };
  const order = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await pool.query<OrderRow>(
    `${ORDER_SELECT}
      WHERE ${where}
      ORDER BY ${ORDER_SORT_COLUMNS[sort.key]} ${order} NULLS LAST, o.created_at DESC, o.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  const billed = await loadBilledOnClient(
    pool,
    orgId,
    rows.map((r) => r.id),
  );
  const byOrder = new Map<string, { orderedMilli: number; billedMilli: number }[]>();
  for (const b of billed) {
    const list = byOrder.get(b.order_id) ?? [];
    list.push({ orderedMilli: Number(b.quantity_milli), billedMilli: Number(b.billed_milli) });
    byOrder.set(b.order_id, list);
  }

  return {
    orders: rows.map((r) => toSummary(r, billingStatusOf(byOrder.get(r.id) ?? []))),
    totalCount,
  };
}

// --------------------------------------------------------------------- drafts

interface PartySnapshot {
  name: string;
  address: string | null;
  taxNumber: string | null;
}

async function readPartyOnClient(
  client: Queryable,
  orgId: string,
  direction: QuoteDirection,
  partyId: string,
): Promise<PartySnapshot> {
  const party = PARTY[direction];
  // `party.table` is one of two constants above, never request input (rule 4).
  const { rows } = await client.query<{ name: string; billing_address: string | null; tax_number: string | null }>(
    `SELECT name, billing_address, tax_number FROM ${party.table}
      WHERE id = $1 AND org_id = $2 AND is_active = true`,
    [partyId, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(422, `${party.label} not found`);
  return { name: row.name, address: row.billing_address, taxNumber: row.tax_number };
}

interface PreparedOrder {
  totals: LineTotal<OrderLineInput>[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currencyCode: string;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  party: PartySnapshot;
}

/**
 * Prices and validates a draft on the caller's client: per-line totals (the
 * same rounding as the invoice/bill it will be billed on), account types for
 * the direction, the stock checks billing would otherwise fail on, and the
 * party snapshot.
 */
async function prepareOnClient(
  client: PoolClient,
  orgId: string,
  direction: QuoteDirection,
  input: CreateOrderInput,
): Promise<PreparedOrder> {
  if (input.lines.length === 0) throw new ApiError(422, 'An order needs at least one line');
  const totals = computeLineTotals(input.lines);
  const { subtotalCents, taxCents, totalCents } = sumDocumentTotals(totals);

  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
  const currencyCode = input.currencyCode ?? baseCurrency;

  const party = await readPartyOnClient(client, orgId, direction, input.partyId);
  if (input.expectedDate !== null && input.expectedDate < input.orderDate) {
    throw new ApiError(422, 'Expected date cannot be before the order date');
  }

  // A payment term is carried to the invoice/bill, so it must exist and be
  // active now; resolving it against the order date also yields its label.
  let paymentTerms = input.paymentTerms;
  let paymentTermsCode: string | null = null;
  if (input.paymentTermsCode !== null) {
    const resolved = await paymentTermService.resolveDueDate(
      client,
      orgId,
      input.orderDate,
      input.paymentTermsCode,
      undefined,
    );
    paymentTermsCode = resolved.paymentTermsCode;
    paymentTerms = paymentTerms ?? resolved.paymentTermsLabel;
  }

  const accountIds = totals.map((t) => t.input.accountId);
  if (direction === 'SALES') {
    await invoiceService.assertRevenueAccounts(client, orgId, accountIds);
  } else {
    await billService.assertExpenseAccounts(client, orgId, accountIds);
  }
  // Early feedback for what billing would refuse (lot/serial items, fixed assets).
  await prepareStockLinesOnClient(
    client,
    orgId,
    totals.map((t, i) => ({ lineNumber: i + 1, itemId: t.input.itemId, stockLocationId: null, quantityMilli: t.input.quantityMilli })),
  );

  return { totals, subtotalCents, taxCents, totalCents, currencyCode, paymentTerms, paymentTermsCode, party };
}

async function insertLinesOnClient(
  client: PoolClient,
  orgId: string,
  orderId: string,
  totals: LineTotal<OrderLineInput>[],
): Promise<void> {
  await client.query(
    `INSERT INTO order_lines
       (org_id, order_id, line_number, description, quantity_milli, unit_price_cents,
        account_id, tax_rate_bp, net_cents, tax_cents, item_id)
     SELECT $1, $2, v.line_number, v.description, v.quantity_milli, v.unit_price_cents,
            v.account_id, v.tax_rate_bp, v.net_cents, v.tax_cents, v.item_id
       FROM unnest($3::smallint[], $4::text[], $5::bigint[], $6::bigint[], $7::uuid[], $8::int[],
                   $9::bigint[], $10::bigint[], $11::uuid[])
            AS v(line_number, description, quantity_milli, unit_price_cents, account_id, tax_rate_bp,
                 net_cents, tax_cents, item_id)`,
    [
      orgId,
      orderId,
      totals.map((_, i) => i + 1),
      totals.map((t) => t.input.description),
      totals.map((t) => t.input.quantityMilli),
      totals.map((t) => t.input.unitPriceCents),
      totals.map((t) => t.input.accountId),
      totals.map((t) => t.input.taxRateBp),
      totals.map((t) => t.netCents),
      totals.map((t) => t.taxCents),
      totals.map((t) => t.input.itemId),
    ],
  );
}

/** Maps a database refusal to the API error a caller should see; anything else is rethrown. */
function mapWriteError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  const code = pgErrorCode(err);
  if (code === PG_FOREIGN_KEY_VIOLATION) {
    throw new ApiError(422, 'A referenced account, item or party does not exist in this organization');
  }
  if (code === PG_UNIQUE_VIOLATION) {
    const constraint = pgConstraint(err);
    if (constraint === 'ux_orders_source_quote') {
      throw new ApiError(409, 'This quote has already been converted');
    }
    if (constraint === 'ux_orders_number') {
      throw new ApiError(409, 'That order number is already in use — raise the next order number in Settings → Invoices');
    }
    if (constraint === 'ux_bills_vendor_reference') {
      throw new ApiError(409, 'A bill with this vendor reference already exists — enter the vendor’s invoice number');
    }
    throw new ApiError(409, 'This change conflicts with another one — reload and try again');
  }
  if (code === PG_FEATURE_NOT_SUPPORTED) throw new ApiError(409, pgErrorMessage(err));
  if (code === PG_RAISE_EXCEPTION) throw new ApiError(422, pgErrorMessage(err));
  throw err;
}

/** Runs `fn` in a transaction, mapping database refusals to API errors. */
async function runOrderWrite<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(fn);
  } catch (err) {
    mapWriteError(err);
  }
}

export async function createOrder(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  input: CreateOrderInput,
): Promise<Order> {
  const id = await runOrderWrite(async (client) => {
    const prepared = await prepareOnClient(client, orgId, direction, input);
    const orderId = randomUUID();
    await client.query(
      `INSERT INTO orders
         (id, org_id, direction, customer_id, vendor_id, status, order_date, expected_date, currency_code,
          party_name_snapshot, party_address_snapshot, party_tax_number_snapshot,
          party_reference, notes, terms, payment_terms, payment_terms_code,
          subtotal_cents, tax_cents, total_cents, created_by)
       VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        orderId,
        orgId,
        direction,
        direction === 'SALES' ? input.partyId : null,
        direction === 'PURCHASE' ? input.partyId : null,
        input.orderDate,
        input.expectedDate,
        prepared.currencyCode,
        prepared.party.name,
        prepared.party.address,
        prepared.party.taxNumber,
        input.partyReference,
        input.notes,
        input.terms,
        prepared.paymentTerms,
        prepared.paymentTermsCode,
        prepared.subtotalCents,
        prepared.taxCents,
        prepared.totalCents,
        userId,
      ],
    );
    await insertLinesOnClient(client, orgId, orderId, prepared.totals);
    return orderId;
  });
  return getOrderById(orgId, direction, id);
}

interface LockedOrder {
  id: string;
  status: OrderStatus;
  partyId: string;
  orderNumber: string | null;
  currencyCode: string;
}

/** Locks one order of this org and direction FOR UPDATE, or 404s. */
async function lockOrderOnClient(
  client: Queryable,
  orgId: string,
  direction: QuoteDirection,
  id: string,
): Promise<LockedOrder> {
  const { rows } = await client.query<{
    id: string;
    status: string;
    customer_id: string | null;
    vendor_id: string | null;
    order_number: string | null;
    currency_code: string;
  }>(
    `SELECT id, status, customer_id, vendor_id, order_number, currency_code
       FROM orders WHERE id = $1 AND org_id = $2 AND direction = $3
      FOR UPDATE`,
    [id, orgId, direction],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Order not found');
  return {
    id: row.id,
    status: statusOf(row),
    partyId: row.customer_id ?? row.vendor_id ?? '',
    orderNumber: row.order_number,
    currencyCode: row.currency_code.trim(),
  };
}

/** A draft edit replaces the whole document, exactly like an invoice draft. */
export async function updateOrder(
  orgId: string,
  direction: QuoteDirection,
  id: string,
  input: UpdateOrderInput,
): Promise<Order> {
  await runOrderWrite(async (client) => {
    const locked = await lockOrderOnClient(client, orgId, direction, id);
    if (locked.status !== 'DRAFT') throw new ApiError(409, 'Only a draft order can be edited');
    const prepared = await prepareOnClient(client, orgId, direction, input);

    await client.query('DELETE FROM order_lines WHERE order_id = $1 AND org_id = $2', [id, orgId]);
    await client.query(
      `UPDATE orders
          SET customer_id = $1, vendor_id = $2, order_date = $3, expected_date = $4, currency_code = $5,
              party_name_snapshot = $6, party_address_snapshot = $7, party_tax_number_snapshot = $8,
              party_reference = $9, notes = $10, terms = $11, payment_terms = $12, payment_terms_code = $13,
              subtotal_cents = $14, tax_cents = $15, total_cents = $16
        WHERE id = $17 AND org_id = $18`,
      [
        direction === 'SALES' ? input.partyId : null,
        direction === 'PURCHASE' ? input.partyId : null,
        input.orderDate,
        input.expectedDate,
        prepared.currencyCode,
        prepared.party.name,
        prepared.party.address,
        prepared.party.taxNumber,
        input.partyReference,
        input.notes,
        input.terms,
        prepared.paymentTerms,
        prepared.paymentTermsCode,
        prepared.subtotalCents,
        prepared.taxCents,
        prepared.totalCents,
        id,
        orgId,
      ],
    );
    await insertLinesOnClient(client, orgId, id, prepared.totals);
  });
  return getOrderById(orgId, direction, id);
}

export async function deleteOrder(orgId: string, direction: QuoteDirection, id: string): Promise<void> {
  const { rows } = await withTransaction((client) =>
    client.query<{ id: string }>(
      `DELETE FROM orders WHERE id = $1 AND org_id = $2 AND direction = $3 AND status = 'DRAFT' RETURNING id`,
      [id, orgId, direction],
    ),
  );
  if (rows[0] !== undefined) return;

  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM orders WHERE id = $1 AND org_id = $2 AND direction = $3',
    [id, orgId, direction],
  );
  if (existing[0] === undefined) throw new ApiError(404, 'Order not found');
  throw new ApiError(409, 'Only a draft order can be deleted — cancel it instead');
}

// ----------------------------------------------------------------- lifecycle

interface TransitionExtras {
  /** CONFIRMED from DRAFT only. */
  userId?: string;
  /** CANCELLED only. */
  reason?: string;
}

/**
 * The one writer of `orders.status` (guardrails rule 10). Locks the order,
 * checks `canTransitionOrder`, and writes the target status with the columns
 * that go with it — each fixed here per target, no caller-supplied column
 * name ever reaches the SQL (rule 4).
 *
 * - CONFIRMED from DRAFT: allocates the gapless number, re-snapshots the party.
 * - CONFIRMED from CLOSED (reopen): clears `closed_at`.
 * - CLOSED: stamps `closed_at`.
 * - CANCELLED: stamps `cancelled_at` and the reason, and only while no
 *   non-VOID invoice or bill still bills this order.
 *
 * Returns the previous status.
 */
async function transitionOrderOnClient(
  client: PoolClient,
  orgId: string,
  direction: QuoteDirection,
  id: string,
  to: Exclude<OrderStatus, 'DRAFT'>,
  extras: TransitionExtras = {},
): Promise<OrderStatus> {
  const locked = await lockOrderOnClient(client, orgId, direction, id);
  const from = locked.status;
  if (!canTransitionOrder(from, to)) {
    throw new ApiError(409, `A ${from.toLowerCase()} order cannot become ${to.toLowerCase()}`);
  }

  switch (to) {
    case 'CONFIRMED': {
      if (from === 'CLOSED') {
        await client.query(
          `UPDATE orders SET status = 'CONFIRMED', closed_at = NULL WHERE id = $1 AND org_id = $2`,
          [id, orgId],
        );
        break;
      }
      const userId = extras.userId;
      if (userId === undefined) throw new Error('transitionOrderOnClient: confirming a draft needs extras.userId');
      const party = await readPartyOnClient(client, orgId, direction, locked.partyId);
      const orderNumber = await invoiceSettingsService.allocateOrderNumber(client, orgId, direction);
      await client.query(
        `UPDATE orders
            SET status = 'CONFIRMED', order_number = $3, confirmed_at = now(), confirmed_by = $4,
                party_name_snapshot = $5, party_address_snapshot = $6, party_tax_number_snapshot = $7
          WHERE id = $1 AND org_id = $2`,
        [id, orgId, orderNumber, userId, party.name, party.address, party.taxNumber],
      );
      break;
    }
    case 'CLOSED':
      await client.query(`UPDATE orders SET status = 'CLOSED', closed_at = now() WHERE id = $1 AND org_id = $2`, [
        id,
        orgId,
      ]);
      break;
    case 'CANCELLED': {
      const reason = extras.reason;
      if (reason === undefined || reason.trim() === '') throw new ApiError(422, 'A reason is required');
      const { rows: live } = await client.query<{ n: number }>(
        `SELECT 1 AS n
           FROM invoice_lines il
           JOIN invoices i ON i.org_id = il.org_id AND i.id = il.invoice_id
           JOIN order_lines ol ON ol.org_id = il.org_id AND ol.id = il.order_line_id
          WHERE ol.org_id = $1 AND ol.order_id = $2 AND i.status <> 'VOID'
          UNION ALL
         SELECT 1
           FROM bill_lines bl
           JOIN bills b ON b.org_id = bl.org_id AND b.id = bl.bill_id
           JOIN order_lines ol ON ol.org_id = bl.org_id AND ol.id = bl.order_line_id
          WHERE ol.org_id = $1 AND ol.order_id = $2 AND b.status <> 'VOID'
          LIMIT 1`,
        [orgId, id],
      );
      if (live[0] !== undefined) {
        throw new ApiError(409, 'Void the invoices raised against this order first');
      }
      await client.query(
        `UPDATE orders SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $3
          WHERE id = $1 AND org_id = $2`,
        [id, orgId, reason],
      );
      break;
    }
  }
  return from;
}

/**
 * DRAFT → CONFIRMED on the caller's transaction: the transition (number,
 * party snapshot, freeze) and the `order.confirmed` event. Shared by the
 * confirm route and quote → order conversion.
 */
async function confirmOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
): Promise<void> {
  const locked = await lockOrderOnClient(client, orgId, direction, id);
  if (locked.status !== 'DRAFT') throw new ApiError(409, 'Only a draft order can be confirmed');
  await transitionOrderOnClient(client, orgId, direction, id, 'CONFIRMED', { userId });
  const { rows } = await client.query<{ order_number: string; total_cents: string; currency_code: string }>(
    'SELECT order_number, total_cents, currency_code FROM orders WHERE id = $1 AND org_id = $2',
    [id, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`Confirmed order ${id} vanished`);
  await emitEvent(client, orgId, MODULE_TAGS.accounting, 'order.confirmed', {
    orderId: id,
    direction,
    orderNumber: row.order_number,
    totalCents: parseCents(row.total_cents),
    currencyCode: row.currency_code.trim(),
  });
}

/** DRAFT → CONFIRMED: numbered, party re-snapshotted, content frozen. */
export async function confirmOrder(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
): Promise<Order> {
  await runOrderWrite((client) => confirmOnClient(client, orgId, userId, direction, id));
  return getOrderById(orgId, direction, id);
}

/** CONFIRMED → CLOSED: no further billing intended. */
export async function closeOrder(orgId: string, direction: QuoteDirection, id: string): Promise<Order> {
  await runOrderWrite((client) => transitionOrderOnClient(client, orgId, direction, id, 'CLOSED'));
  return getOrderById(orgId, direction, id);
}

/** CLOSED → CONFIRMED. */
export async function reopenOrder(orgId: string, direction: QuoteDirection, id: string): Promise<Order> {
  await runOrderWrite((client) => transitionOrderOnClient(client, orgId, direction, id, 'CONFIRMED'));
  return getOrderById(orgId, direction, id);
}

/** CONFIRMED → CANCELLED, with a reason, only when nothing live bills it. */
export async function cancelOrder(
  orgId: string,
  direction: QuoteDirection,
  id: string,
  reason: string,
): Promise<Order> {
  await runOrderWrite(async (client) => {
    await transitionOrderOnClient(client, orgId, direction, id, 'CANCELLED', { reason });
    const { rows } = await client.query<{ order_number: string | null }>(
      'SELECT order_number FROM orders WHERE id = $1 AND org_id = $2',
      [id, orgId],
    );
    await emitEvent(client, orgId, MODULE_TAGS.accounting, 'order.cancelled', {
      orderId: id,
      direction,
      orderNumber: rows[0]?.order_number ?? null,
      reason,
    });
  });
  return getOrderById(orgId, direction, id);
}

// --------------------------------------------------------------- conversion

/** 3000 → "3", 2500 → "2.5", 125 → "0.125" — integer arithmetic, no float. */
function formatQuantityMilli(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const frac = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return frac === '' ? String(whole) : `${String(whole)}.${frac}`;
}

function addDaysIso(isoDate: string, days: number): string {
  return paymentTermService.addDaysIso(isoDate, days);
}

/**
 * POST /:id/convert — bills part or all of a CONFIRMED order: a DRAFT invoice
 * (sales) or DRAFT bill (purchase) whose lines each carry the `order_line_id`
 * they bill, through those services' own `*OnClient` creators on this
 * transaction. Nothing posts here — the document recognises revenue or
 * expense when it is issued/approved.
 *
 * The order row is locked FOR UPDATE first, so two concurrent conversions
 * are serialised and the second reads the first's lines. A request for more
 * than remains is refused with a precise 422 here; the deferred trigger in
 * migration 092 is the backstop for any other route to the same lines (an
 * edit of the draft, say).
 */
export async function convertOrder(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
  input: ConvertOrderInput,
): Promise<{ kind: 'INVOICE' | 'BILL'; id: string }> {
  return runOrderWrite(async (client) => {
    const locked = await lockOrderOnClient(client, orgId, direction, id);
    if (locked.status !== 'CONFIRMED') throw new ApiError(409, 'Only a confirmed order can be invoiced');
    const order = await loadOrder(client, orgId, direction, id);

    // Per order line, the quantity to bill now.
    const requested = new Map<string, number>();
    if (input.lines === null) {
      for (const line of order.lines) {
        if (line.remainingQuantityMilli > 0) requested.set(line.id, line.remainingQuantityMilli);
      }
      if (requested.size === 0) throw new ApiError(409, 'Everything on this order has been billed');
    } else {
      for (const r of input.lines) {
        if (!order.lines.some((l) => l.id === r.orderLineId)) throw new ApiError(422, 'Order line not found');
        requested.set(r.orderLineId, (requested.get(r.orderLineId) ?? 0) + r.quantityMilli);
      }
      for (const line of order.lines) {
        const asked = requested.get(line.id);
        if (asked !== undefined && asked > line.remainingQuantityMilli) {
          throw new ApiError(
            422,
            `Line ${String(line.lineNumber)} has only ${formatQuantityMilli(line.remainingQuantityMilli)} left to bill`,
          );
        }
      }
    }

    const billLines = order.lines.flatMap((l) => {
      const quantityMilli = requested.get(l.id);
      return quantityMilli === undefined ? [] : [{ line: l, quantityMilli }];
    });

    const documentDate = input.documentDate ?? (await orgTodayOnClient(client, orgId));
    let dueDate: string | undefined = input.dueDate ?? undefined;
    if (dueDate === undefined && order.paymentTermsCode === null) {
      const defaults = await invoiceSettingsService.getQuoteDefaultsOnClient(client, orgId);
      dueDate = addDaysIso(documentDate, defaults.defaultDueDays);
    }

    if (direction === 'SALES') {
      const invoiceId = await invoiceService.createInvoiceOnClient(client, orgId, userId, {
        customerId: order.partyId,
        issueDate: documentDate,
        dueDate,
        currencyCode: order.currencyCode,
        notes: order.notes,
        paymentTerms: order.paymentTerms,
        paymentTermsCode: order.paymentTermsCode,
        salesOrderId: id,
        lines: billLines.map(({ line, quantityMilli }) => ({
          description: line.description,
          quantityMilli,
          unitPriceCents: line.unitPriceCents,
          revenueAccountId: line.accountId,
          taxRateBp: line.taxRateBp,
          itemId: line.itemId,
          stockLocationId: null,
          orderLineId: line.id,
        })),
      });
      return { kind: 'INVOICE' as const, id: invoiceId };
    }

    if (order.orderNumber === null) throw new Error(`Confirmed order ${id} has no number`);
    let vendorReference = input.vendorReference;
    if (vendorReference === null) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(DISTINCT bl.bill_id) AS n
           FROM bill_lines bl
           JOIN order_lines ol ON ol.org_id = bl.org_id AND ol.id = bl.order_line_id
          WHERE ol.org_id = $1 AND ol.order_id = $2`,
        [orgId, id],
      );
      vendorReference = `${order.orderNumber}-${String(Number(rows[0]?.n ?? '0') + 1)}`;
    }
    const billId = await billService.createBillOnClient(client, orgId, userId, {
      vendorId: order.partyId,
      vendorReference,
      billDate: documentDate,
      dueDate,
      currencyCode: order.currencyCode,
      notes: order.notes,
      paymentTerms: order.paymentTerms,
      paymentTermsCode: order.paymentTermsCode,
      purchaseOrderId: id,
      lines: billLines.map(({ line, quantityMilli }) => ({
        description: line.description,
        quantityMilli,
        unitPriceCents: line.unitPriceCents,
        expenseAccountId: line.accountId,
        taxRateBp: line.taxRateBp,
        itemId: line.itemId,
        stockLocationId: null,
        orderLineId: line.id,
      })),
    });
    return { kind: 'BILL' as const, id: billId };
  });
}

/**
 * Quote → order, on quoteService.convertQuote's transaction: a CONFIRMED
 * order copying the accepted quote's party, currency, terms, payment terms,
 * notes, reference and lines (the stored net/tax, not recomputed), with
 * `source_quote_id` set — at most one order per quote (`ux_orders_source_quote`).
 * Lines can only be inserted while the order is a DRAFT (migration 092), so
 * it is inserted as one and confirmed through the same transition the confirm
 * route uses. Cancelling the order later does not reopen the quote.
 */
export async function createOrderFromQuoteOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  quote: Quote,
): Promise<string> {
  const orderId = randomUUID();
  const orderDate = await orgTodayOnClient(client, orgId);
  await client.query(
    `INSERT INTO orders
       (id, org_id, direction, customer_id, vendor_id, status, order_date, expected_date, currency_code,
        party_name_snapshot, party_address_snapshot, party_tax_number_snapshot,
        party_reference, notes, terms, payment_terms, payment_terms_code,
        subtotal_cents, tax_cents, total_cents, source_quote_id, source_quote_direction, created_by)
     VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, NULL, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             $19, $3, $20)`,
    [
      orderId,
      orgId,
      quote.direction,
      quote.direction === 'SALES' ? quote.partyId : null,
      quote.direction === 'PURCHASE' ? quote.partyId : null,
      orderDate,
      quote.currencyCode,
      quote.partyNameSnapshot,
      quote.partyAddressSnapshot,
      quote.partyTaxNumberSnapshot,
      quote.partyReference,
      quote.notes,
      quote.terms,
      quote.paymentTerms,
      quote.paymentTermsCode,
      quote.subtotalCents,
      quote.taxCents,
      quote.totalCents,
      quote.id,
      userId,
    ],
  );
  await insertLinesOnClient(
    client,
    orgId,
    orderId,
    quote.lines.map((l) => ({
      input: {
        description: l.description,
        quantityMilli: l.quantityMilli,
        unitPriceCents: l.unitPriceCents,
        accountId: l.accountId,
        taxRateBp: l.taxRateBp,
        itemId: l.itemId,
      },
      netCents: l.netCents,
      taxCents: l.taxCents,
    })),
  );
  await confirmOnClient(client, orgId, userId, quote.direction, orderId);

  // Phase 42 — a quote that asked for a deposit raises the DRAFT deposit
  // invoice/bill in this same transaction, so the order never exists without it.
  if (quote.depositPercentBp !== null) {
    await depositService.createDepositDocumentOnClient(client, orgId, userId, quote.direction, orderId, {
      percentBp: quote.depositPercentBp,
      amountCents: null,
      documentDate: null,
      dueDate: null,
      vendorReference: null,
    });
  }
  return orderId;
}
