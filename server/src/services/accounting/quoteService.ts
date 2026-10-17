import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { env } from '../../config/env.js';
import { MODULE_TAGS } from '../../config/modules.js';
import { QUOTE_LINK_GRACE_MS } from '../../config/constants.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { convertToBase } from '../../utils/fxRate.js';
import { computeLineTotals, sumDocumentTotals, type LineTotal } from '../../utils/documentTotals.js';
import { randomUrlToken, sha256Hex } from '../../utils/pkce.js';
import { emitEvent } from '../outboxService.js';
import { enqueueEmailOnClient } from '../mail/emailOutboxService.js';
import { notifyQuoteRespondedOnClient } from '../mail/notificationService.js';
import { prepareStockLinesOnClient } from './documentStockLines.js';
import * as invoiceService from './invoiceService.js';
import * as billService from './billService.js';
import * as historyService from '../historyService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import { createOrderFromQuoteOnClient } from './orderService.js';
import * as fxRateService from './fxRateService.js';
import { orgTodayOnClient } from './settingsService.js';
import * as paymentTermService from './paymentTermService.js';
import { formatMoney } from './statementEmailService.js';
import { renderQuoteEmailOnClient } from './quoteEmailTemplateService.js';
import { renderQuotePdf } from './quotePdfRenderer.js';
import { addressLines } from './publicStatementService.js';
import * as organizationService from '../organizationService.js';
import * as organizationProfileService from '../organizationProfileService.js';
import * as documentService from '../documentService.js';
import type { PlaceholderContext } from '../../utils/placeholders.js';
import { transitionQuoteOnClient } from './quoteStatusService.js';
import {
  canTransitionQuote,
  effectiveQuoteStatus,
  isQuoteStatus,
  QUOTE_REVISABLE_STATUSES,
  type Quote,
  type QuoteConvertedDocument,
  type QuoteDirection,
  type QuoteLine,
  type QuoteLinkSummary,
  type QuoteResponse,
  type QuoteResponseChannel,
  type QuoteResponseKind,
  type QuoteRevisionSummary,
  type QuoteStatus,
  type QuoteSummary,
} from '../../types/accounting.js';

/**
 * Phase 41 — quotes, sales and purchase.
 *
 * A quote is a commercial offer, not an accounting event: nothing in this
 * file writes `journal_entries`, `ledger_lines`, stock movements or a frozen
 * FX rate. Under IFRS 15 / ASC 606 a contract exists only once the offer is
 * accepted, and even then revenue (or expense) is recognised on the invoice
 * (or bill) it converts into — `convertQuote` creates that document as a
 * DRAFT through invoiceService/billService, which own every posting.
 *
 * Lifecycle (QUOTE_TRANSITIONS): DRAFT is freely editable and deletable. The
 * first send allocates a gapless number, snapshots the party, hashes the
 * content and freezes the row (migration 089's trigger). A change after that
 * is a new *revision* — the same number, revision + 1 — which supersedes the
 * sent version when it is itself sent. Acceptance (public link or recorded
 * by staff) writes insert-only evidence; conversion is manual and once only.
 *
 * `direction` always comes from the route (`/quotes` = SALES,
 * `/purchase-quotes` = PURCHASE) and every query filters on it, so a sales
 * quote id is a 404 on the purchase routes and vice versa.
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
    return typeof err.message === 'string' ? err.message : 'Database rejected the quote';
  }
  return 'Database rejected the quote';
}

/** The party table and label per direction. Identifiers come only from here (rule 4). */
const PARTY = {
  SALES: { table: 'customers', column: 'customer_id', label: 'Customer' },
  PURCHASE: { table: 'vendors', column: 'vendor_id', label: 'Vendor' },
} as const;

// --------------------------------------------------------------------- inputs

export interface QuoteLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  accountId: string;
  taxRateBp: number;
  itemId: string | null;
}

export interface CreateQuoteInput {
  partyId: string;
  quoteDate: string;
  validUntil?: string | undefined;
  currencyCode?: string | undefined;
  partyReference: string | null;
  title: string | null;
  notes: string | null;
  terms?: string | null | undefined;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  /** Phase 42 — share of the total asked for as a deposit on acceptance (basis points), or null. */
  depositPercentBp?: number | null | undefined;
  lines: QuoteLineInput[];
}

export type UpdateQuoteInput = CreateQuoteInput;

export interface SendQuoteInput {
  delivery: 'EMAIL' | 'MANUAL';
  toEmail: string | null;
  message: string | null;
  templateId: string | null;
}

export interface ConvertQuoteInput {
  documentDate: string | null;
  dueDate: string | null;
  vendorReference: string | null;
  /** Phase 42 — ORDER converts to a confirmed order instead of a draft invoice/bill. */
  target: 'INVOICE' | 'ORDER';
}

export const QUOTE_SORT_KEYS = ['quoteDate', 'validUntil', 'number', 'party', 'total', 'status'] as const;
export type QuoteSortKey = (typeof QUOTE_SORT_KEYS)[number];
const QUOTE_SORT_COLUMNS: Record<QuoteSortKey, string> = {
  quoteDate: 'q.quote_date',
  validUntil: 'q.valid_until',
  number: 'q.quote_number',
  party: 'q.party_name_snapshot',
  total: 'q.total_cents',
  status: 'q.status',
};

export interface ListQuotesOptions {
  page: number;
  limit: number;
  /** Filters on the *effective* status: SENT excludes, EXPIRED includes, sent quotes past validity. */
  status: QuoteStatus | null;
  partyId: string | null;
  from: string | null;
  to: string | null;
  q: string | null;
  sort?: { key: QuoteSortKey; direction: 'asc' | 'desc' };
}

// ---------------------------------------------------------------- row mapping

interface QuoteRow {
  id: string;
  direction: QuoteDirection;
  customer_id: string | null;
  vendor_id: string | null;
  party_name: string | null;
  root_quote_id: string;
  supersedes_quote_id: string | null;
  revision: number;
  quote_number: string | null;
  status: string;
  quote_date: string;
  valid_until: string;
  currency_code: string;
  party_name_snapshot: string;
  party_address_snapshot: string | null;
  party_tax_number_snapshot: string | null;
  party_email_snapshot: string | null;
  party_reference: string | null;
  title: string | null;
  notes: string | null;
  terms: string | null;
  payment_terms: string | null;
  payment_terms_code: string | null;
  subtotal_cents: string;
  tax_cents: string;
  total_cents: string;
  deposit_percent_bp: number | null;
  indicative_fx_rate: string | null;
  indicative_base_total_cents: string | null;
  content_sha256: string | null;
  sent_at: Date | null;
  sent_by: string | null;
  accepted_at: Date | null;
  declined_at: Date | null;
  expired_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  superseded_at: Date | null;
  converted_at: Date | null;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const QUOTE_SELECT = `SELECT q.id, q.direction, q.customer_id, q.vendor_id,
                             COALESCE(c.name, v.name) AS party_name,
                             q.root_quote_id, q.supersedes_quote_id, q.revision, q.quote_number, q.status,
                             q.quote_date::text AS quote_date, q.valid_until::text AS valid_until, q.currency_code,
                             q.party_name_snapshot, q.party_address_snapshot, q.party_tax_number_snapshot,
                             q.party_email_snapshot, q.party_reference, q.title, q.notes, q.terms,
                             q.payment_terms, q.payment_terms_code,
                             q.subtotal_cents, q.tax_cents, q.total_cents, q.deposit_percent_bp,
                             q.indicative_fx_rate::text AS indicative_fx_rate, q.indicative_base_total_cents,
                             q.content_sha256, q.sent_at, q.sent_by, q.accepted_at, q.declined_at, q.expired_at,
                             q.voided_at, q.void_reason, q.superseded_at, q.converted_at,
                             q.created_by, u.name AS created_by_name, q.created_at, q.updated_at
                        FROM quotes q
                        LEFT JOIN customers c ON c.id = q.customer_id AND c.org_id = q.org_id
                        LEFT JOIN vendors v   ON v.id = q.vendor_id   AND v.org_id = q.org_id
                        LEFT JOIN users u     ON u.id = q.created_by`;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function statusOf(row: { id: string; status: string }): QuoteStatus {
  if (!isQuoteStatus(row.status)) throw new Error(`Unknown quote status "${row.status}" on quote ${row.id}`);
  return row.status;
}

function toSummary(row: QuoteRow, asOf: string): QuoteSummary {
  const status = statusOf(row);
  return {
    id: row.id,
    direction: row.direction,
    quoteNumber: row.quote_number,
    revision: row.revision,
    status,
    effectiveStatus: effectiveQuoteStatus(status, row.valid_until, asOf),
    partyId: row.customer_id ?? row.vendor_id ?? '',
    partyName: row.party_name ?? row.party_name_snapshot,
    quoteDate: row.quote_date,
    validUntil: row.valid_until,
    currencyCode: row.currency_code.trim(),
    title: row.title,
    totalCents: parseCents(row.total_cents),
    createdAt: row.created_at.toISOString(),
  };
}

interface QuoteLineRow {
  id: string;
  quote_id: string;
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

async function loadLines(q: Queryable, orgId: string, quoteId: string): Promise<QuoteLine[]> {
  const { rows } = await q.query<QuoteLineRow>(
    `SELECT l.id, l.quote_id, l.line_number, l.description, l.quantity_milli, l.unit_price_cents,
            l.account_id, a.code AS account_code, a.name AS account_name,
            l.tax_rate_bp, l.net_cents, l.tax_cents, l.item_id
       FROM quote_lines l
       JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      WHERE l.org_id = $1 AND l.quote_id = $2
      ORDER BY l.line_number ASC`,
    [orgId, quoteId],
  );
  return rows.map((r) => ({
    id: r.id,
    lineNumber: r.line_number,
    description: r.description,
    quantityMilli: Number(r.quantity_milli),
    unitPriceCents: parseCents(r.unit_price_cents),
    accountId: r.account_id,
    accountCode: r.account_code,
    accountName: r.account_name,
    taxRateBp: r.tax_rate_bp,
    netCents: parseCents(r.net_cents),
    taxCents: parseCents(r.tax_cents),
    itemId: r.item_id,
  }));
}

async function loadResponse(q: Queryable, orgId: string, quoteId: string): Promise<QuoteResponse | null> {
  const { rows } = await q.query<{
    response: QuoteResponseKind;
    channel: QuoteResponseChannel;
    signer_name: string | null;
    signer_email: string | null;
    signer_email_verified: boolean;
    terms_accepted: boolean;
    decline_reason: string | null;
    client_ip: string | null;
    user_agent: string | null;
    recorded_by: string | null;
    recorded_by_name: string | null;
    note: string | null;
    quote_content_sha256: string;
    responded_at: Date;
  }>(
    `SELECT r.response, r.channel, r.signer_name, r.signer_email, r.signer_email_verified, r.terms_accepted, r.decline_reason,
            r.client_ip, r.user_agent, r.recorded_by, u.name AS recorded_by_name, r.note,
            r.quote_content_sha256, r.responded_at
       FROM quote_responses r
       LEFT JOIN users u ON u.id = r.recorded_by
      WHERE r.org_id = $1 AND r.quote_id = $2`,
    [orgId, quoteId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    response: r.response,
    channel: r.channel,
    signerName: r.signer_name,
    signerEmail: r.signer_email,
    signerEmailVerified: r.signer_email_verified,
    termsAccepted: r.terms_accepted,
    declineReason: r.decline_reason,
    clientIp: r.client_ip,
    userAgent: r.user_agent,
    recordedBy: r.recorded_by,
    recordedByName: r.recorded_by_name,
    note: r.note,
    quoteContentSha256: r.quote_content_sha256,
    respondedAt: r.responded_at.toISOString(),
  };
}

async function loadLinks(q: Queryable, orgId: string, quoteId: string): Promise<QuoteLinkSummary[]> {
  const { rows } = await q.query<{
    id: string;
    to_email: string;
    sent_by: string;
    sent_by_name: string | null;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
    last_viewed_at: Date | null;
  }>(
    `SELECT l.id, l.to_email, l.sent_by, u.name AS sent_by_name, l.created_at, l.expires_at,
            l.revoked_at, l.last_viewed_at
       FROM quote_links l
       LEFT JOIN users u ON u.id = l.sent_by
      WHERE l.org_id = $1 AND l.quote_id = $2
      ORDER BY l.created_at DESC, l.id DESC`,
    [orgId, quoteId],
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    toEmail: r.to_email,
    sentBy: r.sent_by,
    sentByName: r.sent_by_name,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    revokedAt: iso(r.revoked_at),
    lastViewedAt: iso(r.last_viewed_at),
    live: r.revoked_at === null && r.expires_at.getTime() > now,
  }));
}

async function loadRevisions(q: Queryable, orgId: string, rootQuoteId: string): Promise<QuoteRevisionSummary[]> {
  const { rows } = await q.query<{ id: string; revision: number; status: string }>(
    `SELECT id, revision, status FROM quotes WHERE org_id = $1 AND root_quote_id = $2 ORDER BY revision ASC`,
    [orgId, rootQuoteId],
  );
  return rows.map((r) => ({ id: r.id, revision: r.revision, status: statusOf(r) }));
}

async function loadConvertedDocument(
  q: Queryable,
  orgId: string,
  direction: QuoteDirection,
  quoteId: string,
): Promise<QuoteConvertedDocument | null> {
  // Phase 42 — a quote converts to an order OR a document, never both.
  const { rows: orderRows } = await q.query<{ id: string; order_number: string | null; status: string }>(
    'SELECT id, order_number, status FROM orders WHERE org_id = $1 AND source_quote_id = $2',
    [orgId, quoteId],
  );
  const order = orderRows[0];
  if (order !== undefined) return { kind: 'ORDER', id: order.id, number: order.order_number, status: order.status };

  if (direction === 'SALES') {
    const { rows } = await q.query<{ id: string; invoice_number: string | null; status: string }>(
      'SELECT id, invoice_number, status FROM invoices WHERE org_id = $1 AND source_quote_id = $2',
      [orgId, quoteId],
    );
    const r = rows[0];
    return r === undefined ? null : { kind: 'INVOICE', id: r.id, number: r.invoice_number, status: r.status };
  }
  const { rows } = await q.query<{ id: string; vendor_reference: string; status: string }>(
    'SELECT id, vendor_reference, status FROM bills WHERE org_id = $1 AND source_quote_id = $2',
    [orgId, quoteId],
  );
  const r = rows[0];
  return r === undefined ? null : { kind: 'BILL', id: r.id, number: r.vendor_reference, status: r.status };
}

async function loadQuote(q: Queryable, orgId: string, direction: QuoteDirection, id: string): Promise<Quote> {
  const { rows } = await q.query<QuoteRow>(`${QUOTE_SELECT} WHERE q.id = $1 AND q.org_id = $2 AND q.direction = $3`, [
    id,
    orgId,
    direction,
  ]);
  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Quote not found');

  // Sequential on purpose: `q` may be a transaction's checked-out client, and pg
  // deprecates (and in v9 rejects) overlapping queries on one client.
  const lines = await loadLines(q, orgId, row.id);
  const revisions = await loadRevisions(q, orgId, row.root_quote_id);
  const links = await loadLinks(q, orgId, row.id);
  const response = await loadResponse(q, orgId, row.id);
  const convertedDocument = await loadConvertedDocument(q, orgId, direction, row.id);

  return {
    ...toSummary(row, await orgTodayOnClient(q, orgId)),
    rootQuoteId: row.root_quote_id,
    supersedesQuoteId: row.supersedes_quote_id,
    partyNameSnapshot: row.party_name_snapshot,
    partyAddressSnapshot: row.party_address_snapshot,
    partyTaxNumberSnapshot: row.party_tax_number_snapshot,
    partyEmailSnapshot: row.party_email_snapshot,
    partyReference: row.party_reference,
    notes: row.notes,
    terms: row.terms,
    paymentTerms: row.payment_terms,
    paymentTermsCode: row.payment_terms_code,
    subtotalCents: parseCents(row.subtotal_cents),
    taxCents: parseCents(row.tax_cents),
    depositPercentBp: row.deposit_percent_bp,
    indicativeFxRate: row.indicative_fx_rate,
    indicativeBaseTotalCents:
      row.indicative_base_total_cents === null ? null : parseCents(row.indicative_base_total_cents),
    contentSha256: row.content_sha256,
    sentAt: iso(row.sent_at),
    sentBy: row.sent_by,
    acceptedAt: iso(row.accepted_at),
    declinedAt: iso(row.declined_at),
    expiredAt: iso(row.expired_at),
    voidedAt: iso(row.voided_at),
    voidReason: row.void_reason,
    supersededAt: iso(row.superseded_at),
    convertedAt: iso(row.converted_at),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at.toISOString(),
    lines,
    revisions,
    links,
    response,
    convertedDocument,
  };
}

// ---------------------------------------------------------------------- reads

export async function getQuoteById(orgId: string, direction: QuoteDirection, id: string): Promise<Quote> {
  return loadQuote(pool, orgId, direction, id);
}

function buildFilters(
  orgId: string,
  direction: QuoteDirection,
  options: ListQuotesOptions,
  asOf: string,
): { where: string; values: unknown[] } {
  const clauses = ['q.org_id = $1', 'q.direction = $2'];
  const values: unknown[] = [orgId, direction];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${String(values.length)}`));
  }

  // The effective status: a SENT quote past its validity reads EXPIRED
  // before the sweep persists it, so the two filters partition on the date.
  if (options.status === 'SENT') {
    add((p) => `q.status = 'SENT' AND q.valid_until >= ${p}::date`, asOf);
  } else if (options.status === 'EXPIRED') {
    add((p) => `(q.status = 'EXPIRED' OR (q.status = 'SENT' AND q.valid_until < ${p}::date))`, asOf);
  } else if (options.status !== null) {
    add((p) => `q.status = ${p}`, options.status);
  } else {
    // A superseded version lives on its successor's revision history, not the list.
    clauses.push(`q.status <> 'SUPERSEDED'`);
  }
  if (options.partyId !== null) {
    // The column name is one of PARTY's two constants (rule 4).
    add((p) => `q.${PARTY[direction].column} = ${p}::uuid`, options.partyId);
  }
  if (options.from !== null) add((p) => `q.quote_date >= ${p}::date`, options.from);
  if (options.to !== null) add((p) => `q.quote_date <= ${p}::date`, options.to);
  if (options.q !== null) {
    add(
      (p) =>
        `(q.quote_number ILIKE '%' || ${p} || '%' OR q.party_name_snapshot ILIKE '%' || ${p} || '%'
          OR q.title ILIKE '%' || ${p} || '%' OR q.party_reference ILIKE '%' || ${p} || '%')`,
      options.q,
    );
  }
  return { where: clauses.join(' AND '), values };
}

export async function listQuotes(
  orgId: string,
  direction: QuoteDirection,
  options: ListQuotesOptions,
): Promise<{ quotes: QuoteSummary[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;
  const asOf = await orgTodayOnClient(pool, orgId);
  const { where, values } = buildFilters(orgId, direction, options, asOf);

  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM quotes q WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.total ?? '0');

  const sort = options.sort ?? { key: 'quoteDate', direction: 'desc' };
  const order = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await pool.query<QuoteRow>(
    `${QUOTE_SELECT}
      WHERE ${where}
      ORDER BY ${QUOTE_SORT_COLUMNS[sort.key]} ${order} NULLS LAST, q.created_at DESC, q.id DESC
      LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}`,
    [...values, options.limit, offset],
  );

  return { quotes: rows.map((r) => toSummary(r, asOf)), totalCount };
}

// --------------------------------------------------------------------- drafts

function addDaysIso(isoDate: string, days: number): string {
  return paymentTermService.addDaysIso(isoDate, days);
}

interface PartySnapshot {
  name: string;
  address: string | null;
  taxNumber: string | null;
  email: string | null;
}

async function readPartyOnClient(
  client: Queryable,
  orgId: string,
  direction: QuoteDirection,
  partyId: string,
): Promise<PartySnapshot> {
  const party = PARTY[direction];
  // `party.table` is one of two constants above, never request input (rule 4).
  const { rows } = await client.query<{
    name: string;
    billing_address: string | null;
    tax_number: string | null;
    email: string | null;
  }>(
    `SELECT name, billing_address, tax_number, email FROM ${party.table}
      WHERE id = $1 AND org_id = $2 AND is_active = true`,
    [partyId, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(422, `${party.label} not found`);
  return {
    name: row.name,
    address: row.billing_address,
    taxNumber: row.tax_number,
    email: row.email === null ? null : row.email.toLowerCase(),
  };
}

interface PreparedQuote {
  totals: LineTotal<QuoteLineInput>[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currencyCode: string;
  validUntil: string;
  terms: string | null;
  paymentTerms: string | null;
  paymentTermsCode: string | null;
  depositPercentBp: number | null;
  party: PartySnapshot;
  indicativeFxRate: string | null;
  indicativeBaseTotalCents: number | null;
}

/**
 * Prices and validates a draft on the caller's client: per-line totals (the
 * same rounding as the invoice/bill it will become), account types for the
 * direction, the stock checks conversion would otherwise fail on, the party
 * snapshot, and an indicative base-currency total when a rate exists.
 */
async function prepareOnClient(
  client: PoolClient,
  orgId: string,
  direction: QuoteDirection,
  input: CreateQuoteInput,
): Promise<PreparedQuote> {
  if (input.lines.length === 0) throw new ApiError(422, 'A quote needs at least one line');
  const totals = computeLineTotals(input.lines);
  const { subtotalCents, taxCents, totalCents } = sumDocumentTotals(totals);

  const { rows: orgRows } = await client.query<{ base_currency: string }>(
    'SELECT base_currency FROM organizations WHERE id = $1',
    [orgId],
  );
  const baseCurrency = orgRows[0]?.base_currency.trim();
  if (baseCurrency === undefined) throw new ApiError(404, 'Organization not found');
  const currencyCode = input.currencyCode ?? baseCurrency;

  const depositPercentBp = input.depositPercentBp ?? null;
  if (depositPercentBp !== null && currencyCode !== baseCurrency) {
    // Early feedback for what the order conversion would refuse (deposits are base-currency only).
    throw new ApiError(422, 'Deposits are available on base-currency quotes only');
  }

  const party = await readPartyOnClient(client, orgId, direction, input.partyId);
  const defaults = await invoiceSettingsService.getQuoteDefaultsOnClient(client, orgId);
  const validUntil = input.validUntil ?? addDaysIso(input.quoteDate, defaults.validityDays);
  if (validUntil < input.quoteDate) throw new ApiError(422, 'Valid until cannot be before the quote date');

  // A payment term is carried to the invoice/bill, so it must exist and be
  // active now; resolving it against the quote date also yields its label.
  let paymentTerms = input.paymentTerms;
  let paymentTermsCode: string | null = null;
  if (input.paymentTermsCode !== null) {
    const resolved = await paymentTermService.resolveDueDate(
      client,
      orgId,
      input.quoteDate,
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
  // Early feedback for what conversion would refuse (lot/serial items, fixed assets).
  await prepareStockLinesOnClient(
    client,
    orgId,
    totals.map((t, i) => ({ lineNumber: i + 1, itemId: t.input.itemId, stockLocationId: null, quantityMilli: t.input.quantityMilli })),
  );

  // Indicative only — never frozen, never posted. Absent a rate, absent a figure.
  let indicativeFxRate: string | null = null;
  let indicativeBaseTotalCents: number | null = null;
  if (currencyCode !== baseCurrency) {
    const rate = await fxRateService.resolveRateOnClient(client, orgId, currencyCode, baseCurrency, input.quoteDate);
    if (rate !== null) {
      indicativeFxRate = rate.rate;
      indicativeBaseTotalCents = convertToBase(subtotalCents, rate.rate) + convertToBase(taxCents, rate.rate);
    }
  }

  return {
    totals,
    subtotalCents,
    taxCents,
    totalCents,
    currencyCode,
    validUntil,
    terms: input.terms === undefined ? defaults.terms : input.terms,
    paymentTerms,
    paymentTermsCode,
    depositPercentBp,
    party,
    indicativeFxRate,
    indicativeBaseTotalCents,
  };
}

async function insertLinesOnClient(
  client: PoolClient,
  orgId: string,
  quoteId: string,
  totals: LineTotal<QuoteLineInput>[],
): Promise<void> {
  await client.query(
    `INSERT INTO quote_lines
       (org_id, quote_id, line_number, description, quantity_milli, unit_price_cents,
        account_id, tax_rate_bp, net_cents, tax_cents, item_id)
     SELECT $1, $2, v.line_number, v.description, v.quantity_milli, v.unit_price_cents,
            v.account_id, v.tax_rate_bp, v.net_cents, v.tax_cents, v.item_id
       FROM unnest($3::smallint[], $4::text[], $5::bigint[], $6::bigint[], $7::uuid[], $8::int[],
                   $9::bigint[], $10::bigint[], $11::uuid[])
            AS v(line_number, description, quantity_milli, unit_price_cents, account_id, tax_rate_bp,
                 net_cents, tax_cents, item_id)`,
    [
      orgId,
      quoteId,
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
    if (constraint === 'ux_invoices_source_quote' || constraint === 'ux_bills_source_quote') {
      throw new ApiError(409, 'This quote has already been converted');
    }
    if (constraint === 'ux_bills_vendor_reference') {
      throw new ApiError(409, 'A bill with this vendor reference already exists — enter the vendor’s invoice number');
    }
    if (constraint === 'ux_quotes_one_draft_per_root' || constraint === 'ux_quotes_supersedes') {
      throw new ApiError(409, 'A draft revision of this quote already exists');
    }
    if (constraint === 'ux_quotes_number') {
      throw new ApiError(409, 'That quote number is already in use — raise the next quote number in Settings → Invoices');
    }
    if (constraint === 'ux_quote_responses_quote') {
      throw new ApiError(409, 'This quote has already been answered');
    }
    throw new ApiError(409, 'This change conflicts with another one — reload and try again');
  }
  if (code === PG_FEATURE_NOT_SUPPORTED) throw new ApiError(409, pgErrorMessage(err));
  if (code === PG_RAISE_EXCEPTION) throw new ApiError(422, pgErrorMessage(err));
  throw err;
}

/** Runs `fn` in a transaction, mapping database refusals to API errors. Shared with publicQuoteService. */
export async function runQuoteWrite<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(fn);
  } catch (err) {
    mapWriteError(err);
  }
}

export async function createQuote(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  input: CreateQuoteInput,
): Promise<Quote> {
  const id = await runQuoteWrite(async (client) => {
    const prepared = await prepareOnClient(client, orgId, direction, input);
    const quoteId = randomUUID();
    await client.query(
      `INSERT INTO quotes
         (id, org_id, direction, customer_id, vendor_id, root_quote_id, revision, status,
          quote_date, valid_until, currency_code,
          party_name_snapshot, party_address_snapshot, party_tax_number_snapshot, party_email_snapshot,
          party_reference, title, notes, terms, payment_terms, payment_terms_code,
          subtotal_cents, tax_cents, total_cents, indicative_fx_rate, indicative_base_total_cents, created_by,
          deposit_percent_bp)
       VALUES ($1, $2, $3, $4, $5, $1, 1, 'DRAFT', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25)`,
      [
        quoteId,
        orgId,
        direction,
        direction === 'SALES' ? input.partyId : null,
        direction === 'PURCHASE' ? input.partyId : null,
        input.quoteDate,
        prepared.validUntil,
        prepared.currencyCode,
        prepared.party.name,
        prepared.party.address,
        prepared.party.taxNumber,
        prepared.party.email,
        input.partyReference,
        input.title,
        input.notes,
        prepared.terms,
        prepared.paymentTerms,
        prepared.paymentTermsCode,
        prepared.subtotalCents,
        prepared.taxCents,
        prepared.totalCents,
        prepared.indicativeFxRate,
        prepared.indicativeBaseTotalCents,
        userId,
        prepared.depositPercentBp,
      ],
    );
    await insertLinesOnClient(client, orgId, quoteId, prepared.totals);
    await historyService.recordEventOnClient(client, orgId, {
      entityType: direction === 'SALES' ? 'QUOTE' : 'PURCHASE_QUOTE',
      entityId: quoteId,
      action: 'CREATED',
      summary: 'Draft created',
    });
    return quoteId;
  });
  return getQuoteById(orgId, direction, id);
}

interface LockedQuote {
  id: string;
  status: QuoteStatus;
  revision: number;
  rootQuoteId: string;
  supersedesQuoteId: string | null;
  partyId: string;
  quoteNumber: string | null;
  validUntil: string;
}

/** Locks one quote of this org and direction FOR UPDATE, or 404s. */
async function lockQuoteOnClient(
  client: Queryable,
  orgId: string,
  direction: QuoteDirection,
  id: string,
): Promise<LockedQuote> {
  const { rows } = await client.query<{
    id: string;
    status: string;
    revision: number;
    root_quote_id: string;
    supersedes_quote_id: string | null;
    customer_id: string | null;
    vendor_id: string | null;
    quote_number: string | null;
    valid_until: string;
  }>(
    `SELECT id, status, revision, root_quote_id, supersedes_quote_id, customer_id, vendor_id, quote_number,
            valid_until::text AS valid_until
       FROM quotes WHERE id = $1 AND org_id = $2 AND direction = $3
      FOR UPDATE`,
    [id, orgId, direction],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Quote not found');
  return {
    id: row.id,
    status: statusOf(row),
    revision: row.revision,
    rootQuoteId: row.root_quote_id,
    supersedesQuoteId: row.supersedes_quote_id,
    partyId: row.customer_id ?? row.vendor_id ?? '',
    quoteNumber: row.quote_number,
    validUntil: row.valid_until,
  };
}

/**
 * Locks every version in a quote's revision chain, in id order, so two
 * transactions working on the same chain (a send racing a revise) always
 * take their locks in the same order and cannot deadlock.
 */
async function lockChainOnClient(client: Queryable, orgId: string, direction: QuoteDirection, id: string): Promise<void> {
  const { rows } = await client.query<{ root_quote_id: string }>(
    'SELECT root_quote_id FROM quotes WHERE id = $1 AND org_id = $2 AND direction = $3',
    [id, orgId, direction],
  );
  const root = rows[0]?.root_quote_id;
  if (root === undefined) throw new ApiError(404, 'Quote not found');
  await client.query('SELECT id FROM quotes WHERE org_id = $1 AND root_quote_id = $2 ORDER BY id FOR UPDATE', [
    orgId,
    root,
  ]);
}

/** A draft edit replaces the whole document, exactly like an invoice draft. */
export async function updateQuote(
  orgId: string,
  direction: QuoteDirection,
  id: string,
  input: UpdateQuoteInput,
): Promise<Quote> {
  await runQuoteWrite(async (client) => {
    const locked = await lockQuoteOnClient(client, orgId, direction, id);
    if (locked.status !== 'DRAFT') {
      throw new ApiError(409, 'Only a draft quote can be edited — create a revision instead');
    }
    if (locked.revision > 1 && input.partyId !== locked.partyId) {
      throw new ApiError(422, 'A revision keeps the party of the quote it revises');
    }
    const prepared = await prepareOnClient(client, orgId, direction, input);

    await client.query('DELETE FROM quote_lines WHERE quote_id = $1 AND org_id = $2', [id, orgId]);
    await client.query(
      `UPDATE quotes
          SET customer_id = $1, vendor_id = $2, quote_date = $3, valid_until = $4, currency_code = $5,
              party_name_snapshot = $6, party_address_snapshot = $7, party_tax_number_snapshot = $8,
              party_email_snapshot = $9, party_reference = $10, title = $11, notes = $12, terms = $13,
              payment_terms = $14, payment_terms_code = $15,
              subtotal_cents = $16, tax_cents = $17, total_cents = $18,
              indicative_fx_rate = $19, indicative_base_total_cents = $20, deposit_percent_bp = $21
        WHERE id = $22 AND org_id = $23`,
      [
        direction === 'SALES' ? input.partyId : null,
        direction === 'PURCHASE' ? input.partyId : null,
        input.quoteDate,
        prepared.validUntil,
        prepared.currencyCode,
        prepared.party.name,
        prepared.party.address,
        prepared.party.taxNumber,
        prepared.party.email,
        input.partyReference,
        input.title,
        input.notes,
        prepared.terms,
        prepared.paymentTerms,
        prepared.paymentTermsCode,
        prepared.subtotalCents,
        prepared.taxCents,
        prepared.totalCents,
        prepared.indicativeFxRate,
        prepared.indicativeBaseTotalCents,
        prepared.depositPercentBp,
        id,
        orgId,
      ],
    );
    await insertLinesOnClient(client, orgId, id, prepared.totals);
    await historyService.recordEventOnClient(client, orgId, {
      entityType: direction === 'SALES' ? 'QUOTE' : 'PURCHASE_QUOTE',
      entityId: id,
      action: 'UPDATED',
      summary: 'Draft edited',
    });
  });
  return getQuoteById(orgId, direction, id);
}

export async function deleteQuote(orgId: string, direction: QuoteDirection, id: string): Promise<void> {
  const { rows } = await withTransaction((client) =>
    client.query<{ id: string }>(
      `DELETE FROM quotes WHERE id = $1 AND org_id = $2 AND direction = $3 AND status = 'DRAFT' RETURNING id`,
      [id, orgId, direction],
    ),
  );
  if (rows[0] !== undefined) return;

  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM quotes WHERE id = $1 AND org_id = $2 AND direction = $3',
    [id, orgId, direction],
  );
  if (existing[0] === undefined) throw new ApiError(404, 'Quote not found');
  throw new ApiError(409, 'Only a draft quote can be deleted — void it instead');
}

// ------------------------------------------------------------- send / freeze

/**
 * The exact content a recipient sees and accepts, in a fixed key order —
 * `JSON.stringify` preserves insertion order, so building the object the
 * same way every time makes its hash deterministic.
 */
function canonicalContent(
  quote: {
    direction: QuoteDirection;
    quoteNumber: string;
    revision: number;
    quoteDate: string;
    validUntil: string;
    currencyCode: string;
    party: PartySnapshot;
    partyReference: string | null;
    title: string | null;
    notes: string | null;
    terms: string | null;
    paymentTerms: string | null;
    depositPercentBp: number | null;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  },
  lines: QuoteLine[],
): string {
  return JSON.stringify({
    direction: quote.direction,
    quoteNumber: quote.quoteNumber,
    revision: quote.revision,
    quoteDate: quote.quoteDate,
    validUntil: quote.validUntil,
    currencyCode: quote.currencyCode,
    party: {
      name: quote.party.name,
      address: quote.party.address,
      taxNumber: quote.party.taxNumber,
    },
    partyReference: quote.partyReference,
    title: quote.title,
    notes: quote.notes,
    terms: quote.terms,
    paymentTerms: quote.paymentTerms,
    // Phase 42 — after paymentTerms. Applies to quotes sent from Phase 42 on; a
    // quote already sent keeps its stored hash (it is never recomputed).
    depositPercentBp: quote.depositPercentBp,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber,
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      taxRateBp: l.taxRateBp,
      netCents: l.netCents,
      taxCents: l.taxCents,
    })),
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
  });
}

/**
 * DRAFT → SENT. Locks the revision chain, re-snapshots the party, allocates
 * (or inherits) the number, hashes the content, supersedes a SENT
 * predecessor and freezes this version — all on the caller's transaction.
 */
async function finalizeOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
): Promise<void> {
  await lockChainOnClient(client, orgId, direction, id);
  const locked = await lockQuoteOnClient(client, orgId, direction, id);
  if (!canTransitionQuote(locked.status, 'SENT')) {
    throw new ApiError(409, `A ${locked.status.toLowerCase()} quote cannot be sent`);
  }
  if (locked.validUntil < (await orgTodayOnClient(client, orgId))) {
    throw new ApiError(422, 'This quote’s validity date has passed — change it before sending');
  }

  const quote = await loadQuote(client, orgId, direction, id);
  const party = await readPartyOnClient(client, orgId, direction, quote.partyId);

  let quoteNumber: string;
  if (locked.supersedesQuoteId === null) {
    quoteNumber = await invoiceSettingsService.allocateQuoteNumber(client, orgId, direction);
  } else {
    const predecessor = await lockQuoteOnClient(client, orgId, direction, locked.supersedesQuoteId);
    if (predecessor.quoteNumber === null) throw new Error(`Predecessor ${predecessor.id} of ${id} has no number`);
    quoteNumber = predecessor.quoteNumber;
    if (predecessor.status === 'ACCEPTED' || predecessor.status === 'CONVERTED') {
      throw new ApiError(
        409,
        `Revision ${String(predecessor.revision)} was accepted while this revision was drafted — void it first, or delete this draft`,
      );
    }
    if (predecessor.status === 'SENT') {
      await transitionQuoteOnClient(client, orgId, predecessor.id, 'SUPERSEDED');
      await client.query(
        'UPDATE quote_links SET revoked_at = now() WHERE org_id = $1 AND quote_id = $2 AND revoked_at IS NULL',
        [orgId, predecessor.id],
      );
    }
  }

  const contentSha256 = sha256Hex(
    canonicalContent(
      {
        direction,
        quoteNumber,
        revision: quote.revision,
        quoteDate: quote.quoteDate,
        validUntil: quote.validUntil,
        currencyCode: quote.currencyCode,
        party,
        partyReference: quote.partyReference,
        title: quote.title,
        notes: quote.notes,
        terms: quote.terms,
        paymentTerms: quote.paymentTerms,
        depositPercentBp: quote.depositPercentBp,
        subtotalCents: quote.subtotalCents,
        taxCents: quote.taxCents,
        totalCents: quote.totalCents,
      },
      quote.lines,
    ),
  );

  await client.query(
    `UPDATE quotes
        SET status = 'SENT', quote_number = $3, content_sha256 = $4, sent_at = now(), sent_by = $5,
            party_name_snapshot = $6, party_address_snapshot = $7, party_tax_number_snapshot = $8,
            party_email_snapshot = $9
      WHERE id = $1 AND org_id = $2 AND status = 'DRAFT'`,
    [id, orgId, quoteNumber, contentSha256, userId, party.name, party.address, party.taxNumber, party.email],
  );

  await emitEvent(client, orgId, MODULE_TAGS.accounting, 'quote.sent', {
    quoteId: id,
    direction,
    quoteNumber,
    revision: quote.revision,
    totalCents: quote.totalCents,
    currencyCode: quote.currencyCode,
  });
}

function publicLinkFor(token: string): string {
  return `${new URL(env.FRONTEND_URL).origin}/quote/${encodeURIComponent(token)}`;
}

/**
 * POST /:id/send. A DRAFT is finalized first; a SENT quote may be re-emailed
 * (to the same or another address), which revokes its previous link so only
 * one link per quote is ever live. MANUAL delivery only finalizes — for a
 * quote printed or sent by hand.
 */
export async function sendQuote(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
  input: SendQuoteInput,
): Promise<Quote> {
  await runQuoteWrite(async (client) => {
    const current = await lockQuoteOnClient(client, orgId, direction, id);
    if (current.status === 'DRAFT') {
      await finalizeOnClient(client, orgId, userId, direction, id);
    } else if (current.status !== 'SENT' || input.delivery === 'MANUAL') {
      throw new ApiError(409, current.status === 'SENT' ? 'This quote has already been sent' : `A ${current.status.toLowerCase()} quote cannot be sent`);
    } else if (current.validUntil < (await orgTodayOnClient(client, orgId))) {
      throw new ApiError(409, 'This quote has expired — create a revision to send it again');
    }

    if (input.delivery === 'EMAIL') {
      const toEmail = input.toEmail;
      if (toEmail === null) throw new ApiError(422, 'An email address is required to email a quote');
      const quote = await loadQuote(client, orgId, direction, id);
      if (quote.quoteNumber === null) throw new Error(`Sent quote ${id} has no number`);

      await client.query(
        'UPDATE quote_links SET revoked_at = now() WHERE org_id = $1 AND quote_id = $2 AND revoked_at IS NULL',
        [orgId, id],
      );
      const token = randomUrlToken();
      // Valid through the whole of valid_until (UTC), then a read-only grace period.
      const expiresAt = new Date(Date.parse(`${quote.validUntil}T00:00:00Z`) + 24 * 60 * 60 * 1000 + QUOTE_LINK_GRACE_MS);
      await client.query(
        `INSERT INTO quote_links (org_id, quote_id, to_email, sent_by, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orgId, id, toEmail.toLowerCase(), userId, sha256Hex(token), expiresAt],
      );

      const { rows: orgRows } = await client.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [
        orgId,
      ]);
      const rendered = await renderQuoteEmailOnClient(
        client,
        orgId,
        direction,
        input.templateId,
        quoteEmailContext(quote, orgRows[0]?.name ?? ''),
      );
      await enqueueEmailOnClient(client, {
        orgId,
        to: toEmail.toLowerCase(),
        toName: quote.partyNameSnapshot,
        template: 'quote_sent',
        data: {
          organizationName: orgRows[0]?.name ?? '',
          direction,
          quoteNumber: quote.quoteNumber,
          revision: quote.revision,
          title: quote.title,
          total: formatMoney(quote.totalCents, quote.currencyCode),
          validUntil: quote.validUntil,
          message: input.message,
          subject: rendered.subject,
          body: rendered.body,
        },
        link: publicLinkFor(token),
      });
    }

    await historyService.recordEventOnClient(client, orgId, {
      entityType: direction === 'SALES' ? 'QUOTE' : 'PURCHASE_QUOTE',
      entityId: id,
      action: 'SENT',
      summary: input.delivery === 'EMAIL' && input.toEmail !== null ? `Sent to ${input.toEmail.toLowerCase()}` : 'Marked as sent',
    });
  });
  return getQuoteById(orgId, direction, id);
}

function quoteEmailContext(quote: Quote, organisationName: string): PlaceholderContext {
  return {
    date: quote.quoteDate,
    contactName: quote.partyNameSnapshot,
    organisationName,
    quoteNumber: quote.quoteNumber,
    quoteTotal: formatMoney(quote.totalCents, quote.currencyCode),
    validUntil: quote.validUntil,
    quoteTitle: quote.title,
  };
}

/** POST /:id/email-preview — the subject and body the chosen template would send for this quote. Read-only. */
export async function previewQuoteEmail(
  orgId: string,
  direction: QuoteDirection,
  id: string,
  templateId: string | null,
): Promise<{ subject: string; body: string }> {
  const quote = await loadQuote(pool, orgId, direction, id);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);
  return renderQuoteEmailOnClient(pool, orgId, direction, templateId, quoteEmailContext(quote, rows[0]?.name ?? ''));
}

const PDF_LOGO_TYPES = new Set(['image/png', 'image/jpeg']);

/** Reads the org logo from the Document Vault (tenant-scoped); PNG/JPEG only, anything else is no logo. */
async function readLogoBytes(orgId: string, logoDocumentId: string | null): Promise<Buffer | null> {
  if (logoDocumentId === null) return null;
  const { document, stream } = await documentService.openDocumentStream(orgId, logoDocumentId);
  if (!PDF_LOGO_TYPES.has(document.mimeType)) {
    stream.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Renders an already-loaded quote. Shared by the staff and public routes — both scope by `orgId`. */
export async function buildQuotePdf(orgId: string, quote: Quote): Promise<{ filename: string; pdf: Buffer }> {
  const [organization, profile] = await Promise.all([
    organizationService.getById(orgId),
    organizationProfileService.getProfile(orgId),
  ]);
  const logo = await readLogoBytes(orgId, profile.logoDocumentId);
  const pdf = await renderQuotePdf({
    merchantName: organization.name,
    merchantAddressLines: addressLines(profile),
    logo,
    direction: quote.direction,
    quoteNumber: quote.quoteNumber,
    revision: quote.revision,
    partyName: quote.partyNameSnapshot,
    partyAddress: quote.partyAddressSnapshot,
    partyTaxNumber: quote.partyTaxNumberSnapshot,
    partyReference: quote.partyReference,
    quoteDate: quote.quoteDate,
    validUntil: quote.validUntil,
    currencyCode: quote.currencyCode,
    title: quote.title,
    notes: quote.notes,
    terms: quote.terms,
    paymentTerms: quote.paymentTerms,
    depositPercentBp: quote.depositPercentBp,
    lines: quote.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      taxRateBp: l.taxRateBp,
      netCents: l.netCents,
    })),
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
  });
  const filename =
    quote.quoteNumber === null
      ? 'quote-draft.pdf'
      : `${quote.quoteNumber}${quote.revision > 1 ? `-rev${String(quote.revision)}` : ''}.pdf`;
  return { filename, pdf };
}

/** GET /:id/pdf */
export async function getQuotePdf(
  orgId: string,
  direction: QuoteDirection,
  id: string,
): Promise<{ filename: string; pdf: Buffer }> {
  return buildQuotePdf(orgId, await getQuoteById(orgId, direction, id));
}

/** POST /:id/revise — a new DRAFT revision of a sent, declined or expired quote. */
export async function reviseQuote(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
): Promise<Quote> {
  const newId = await runQuoteWrite(async (client) => {
    await lockChainOnClient(client, orgId, direction, id);
    const source = await lockQuoteOnClient(client, orgId, direction, id);
    if (!QUOTE_REVISABLE_STATUSES.includes(source.status)) {
      throw new ApiError(
        409,
        source.status === 'ACCEPTED' || source.status === 'CONVERTED'
          ? 'An accepted quote cannot be revised — void it and create a new quote'
          : `A ${source.status.toLowerCase()} quote cannot be revised`,
      );
    }
    const { rows: drafts } = await client.query<{ id: string }>(
      `SELECT id FROM quotes WHERE org_id = $1 AND root_quote_id = $2 AND status = 'DRAFT'`,
      [orgId, source.rootQuoteId],
    );
    if (drafts[0] !== undefined) throw new ApiError(409, 'A draft revision of this quote already exists');

    // A revision is a fresh offer: dated today, open for as long as the original was.
    const quoteId = randomUUID();
    const quoteDate = await orgTodayOnClient(client, orgId);
    await client.query(
      `INSERT INTO quotes
         (id, org_id, direction, customer_id, vendor_id, root_quote_id, supersedes_quote_id, revision, status,
          quote_date, valid_until, currency_code,
          party_name_snapshot, party_address_snapshot, party_tax_number_snapshot, party_email_snapshot,
          party_reference, title, notes, terms, payment_terms, payment_terms_code,
          subtotal_cents, tax_cents, total_cents, indicative_fx_rate, indicative_base_total_cents, created_by,
          deposit_percent_bp)
       SELECT $1, org_id, direction, customer_id, vendor_id, root_quote_id, id, revision + 1, 'DRAFT',
              $2::date, $2::date + (valid_until - quote_date), currency_code,
              party_name_snapshot, party_address_snapshot, party_tax_number_snapshot, party_email_snapshot,
              party_reference, title, notes, terms, payment_terms, payment_terms_code,
              subtotal_cents, tax_cents, total_cents, indicative_fx_rate, indicative_base_total_cents, $3,
              deposit_percent_bp
         FROM quotes WHERE id = $4 AND org_id = $5`,
      [quoteId, quoteDate, userId, id, orgId],
    );
    await client.query(
      `INSERT INTO quote_lines
         (org_id, quote_id, line_number, description, quantity_milli, unit_price_cents,
          account_id, tax_rate_bp, net_cents, tax_cents, item_id)
       SELECT org_id, $1, line_number, description, quantity_milli, unit_price_cents,
              account_id, tax_rate_bp, net_cents, tax_cents, item_id
         FROM quote_lines WHERE quote_id = $2 AND org_id = $3`,
      [quoteId, id, orgId],
    );
    await historyService.recordEventOnClient(client, orgId, {
      entityType: direction === 'SALES' ? 'QUOTE' : 'PURCHASE_QUOTE',
      entityId: quoteId,
      action: 'REVISED',
      summary: `Revised (revision ${source.revision + 1})`,
    });
    return quoteId;
  });
  return getQuoteById(orgId, direction, newId);
}

/** POST /:id/void — withdraw a sent or accepted (not yet converted) quote. */
export async function voidQuote(orgId: string, direction: QuoteDirection, id: string, reason: string): Promise<Quote> {
  await runQuoteWrite(async (client) => {
    await lockQuoteOnClient(client, orgId, direction, id);
    await transitionQuoteOnClient(client, orgId, id, 'VOID', { reason });
    await client.query(
      'UPDATE quote_links SET revoked_at = now() WHERE org_id = $1 AND quote_id = $2 AND revoked_at IS NULL',
      [orgId, id],
    );
  });
  return getQuoteById(orgId, direction, id);
}

/** POST /:id/links/:linkId/revoke */
export async function revokeLink(orgId: string, direction: QuoteDirection, quoteId: string, linkId: string): Promise<Quote> {
  await runQuoteWrite(async (client) => {
    await lockQuoteOnClient(client, orgId, direction, quoteId);
    const { rowCount } = await client.query(
      `UPDATE quote_links SET revoked_at = now()
        WHERE id = $1 AND org_id = $2 AND quote_id = $3 AND revoked_at IS NULL`,
      [linkId, orgId, quoteId],
    );
    if (rowCount === 0) throw new ApiError(404, 'Live link not found');
  });
  return getQuoteById(orgId, direction, quoteId);
}

// ---------------------------------------------------------------- responses

export interface ResponseEvidence {
  response: QuoteResponseKind;
  channel: QuoteResponseChannel;
  linkId: string | null;
  signerName: string | null;
  signerEmail: string | null;
  /** True only when an emailed one-time code for signerEmail was consumed in this transaction. */
  signerEmailVerified: boolean;
  termsAccepted: boolean;
  declineReason: string | null;
  clientIp: string | null;
  userAgent: string | null;
  recordedBy: string | null;
  note: string | null;
  /** PUBLIC_LINK accepts must quote back the hash of what the signer saw. */
  expectedContentSha256: string | null;
}

/**
 * The shared core of every accept/decline — public link or recorded by
 * staff — on the caller's transaction, with the quote already locked by the
 * caller. Writes the insert-only evidence row, then the transition, the
 * outbox event and the sender's notification.
 */
export async function respondOnClient(
  client: PoolClient,
  orgId: string,
  quoteId: string,
  evidence: ResponseEvidence,
): Promise<void> {
  const { rows } = await client.query<{ status: string; valid_until: string; content_sha256: string | null; direction: QuoteDirection; quote_number: string | null }>(
    `SELECT status, valid_until::text AS valid_until, content_sha256, direction, quote_number
       FROM quotes WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [quoteId, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Quote not found');
  if (row.status !== 'SENT' || row.content_sha256 === null) {
    throw new ApiError(409, 'This quote is no longer open for a response');
  }
  if (row.valid_until < (await orgTodayOnClient(client, orgId))) {
    throw new ApiError(409, 'This quote has expired and can no longer be accepted or declined');
  }
  if (evidence.expectedContentSha256 !== null && evidence.expectedContentSha256 !== row.content_sha256) {
    throw new ApiError(409, 'This quote has changed since you opened it — reload the page to see the current version');
  }

  await client.query(
    `INSERT INTO quote_responses
       (org_id, quote_id, link_id, response, channel, signer_name, signer_email, terms_accepted,
        decline_reason, client_ip, user_agent, recorded_by, note, quote_content_sha256, signer_email_verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      orgId,
      quoteId,
      evidence.linkId,
      evidence.response,
      evidence.channel,
      evidence.signerName,
      evidence.signerEmail,
      evidence.termsAccepted,
      evidence.declineReason,
      evidence.clientIp?.slice(0, 45) ?? null,
      evidence.userAgent?.slice(0, 300) ?? null,
      evidence.recordedBy,
      evidence.note,
      row.content_sha256,
      evidence.signerEmailVerified,
    ],
  );
  await transitionQuoteOnClient(client, orgId, quoteId, evidence.response);
  await emitEvent(client, orgId, MODULE_TAGS.accounting, evidence.response === 'ACCEPTED' ? 'quote.accepted' : 'quote.declined', {
    quoteId,
    direction: row.direction,
    quoteNumber: row.quote_number,
    channel: evidence.channel,
  });
  await notifyQuoteRespondedOnClient(
    client,
    orgId,
    quoteId,
    { response: evidence.response, signerName: evidence.signerName, declineReason: evidence.declineReason },
    evidence.recordedBy,
  );
}

/**
 * POST /:id/accept and /:id/decline — staff record an answer received
 * another way (a signed PDF, an email, a phone call). A DRAFT is finalized
 * first (numbered and frozen, no email), so the evidence always refers to a
 * fixed, hashed version.
 */
export async function recordResponse(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
  input:
    | { response: 'ACCEPTED'; signerName: string; note: string | null }
    | { response: 'DECLINED'; reason: string | null; note: string | null },
): Promise<Quote> {
  await runQuoteWrite(async (client) => {
    const current = await lockQuoteOnClient(client, orgId, direction, id);
    if (current.status === 'DRAFT') await finalizeOnClient(client, orgId, userId, direction, id);
    await respondOnClient(client, orgId, id, {
      response: input.response,
      channel: 'INTERNAL',
      linkId: null,
      signerName: input.response === 'ACCEPTED' ? input.signerName : null,
      signerEmail: null,
      signerEmailVerified: false,
      termsAccepted: input.response === 'ACCEPTED',
      declineReason: input.response === 'DECLINED' ? input.reason : null,
      clientIp: null,
      userAgent: null,
      recordedBy: userId,
      note: input.note,
      expectedContentSha256: null,
    });
  });
  return getQuoteById(orgId, direction, id);
}

// --------------------------------------------------------------- conversion

/**
 * POST /:id/convert — an ACCEPTED quote becomes a DRAFT invoice (sales) or
 * DRAFT bill (purchase), through those services' own `*OnClient` creators on
 * this transaction. Nothing posts here: the new document recognises revenue
 * or expense only when it is issued/approved, at the FX rate of its own date.
 * Once only — `ux_invoices_source_quote` / `ux_bills_source_quote` decide a
 * race; deleting the draft (not voiding it) frees the quote again.
 *
 * Phase 42: `target: 'ORDER'` creates a confirmed order instead (partial
 * invoicing/billing then happens against the order). An order cannot be
 * deleted once confirmed, so there is no revert path, and cancelling it does
 * not reopen the quote.
 */
export async function convertQuote(
  orgId: string,
  userId: string,
  direction: QuoteDirection,
  id: string,
  input: ConvertQuoteInput,
): Promise<{ kind: 'INVOICE' | 'BILL' | 'ORDER'; id: string }> {
  return runQuoteWrite(async (client) => {
    const locked = await lockQuoteOnClient(client, orgId, direction, id);
    if (locked.status !== 'ACCEPTED') {
      throw new ApiError(
        409,
        locked.status === 'CONVERTED' ? 'This quote has already been converted' : 'Only an accepted quote can be converted',
      );
    }
    const quote = await loadQuote(client, orgId, direction, id);
    if (input.target === 'ORDER') {
      const orderId = await createOrderFromQuoteOnClient(client, orgId, userId, quote);
      await transitionQuoteOnClient(client, orgId, id, 'CONVERTED', { userId });
      await emitEvent(client, orgId, MODULE_TAGS.accounting, 'quote.converted', {
        quoteId: id,
        direction,
        quoteNumber: quote.quoteNumber,
        documentKind: 'ORDER',
        documentId: orderId,
      });
      return { kind: 'ORDER' as const, id: orderId };
    }
    if (quote.depositPercentBp !== null) {
      // The deposit is raised against a CONFIRMED order; there is no order to hang it on here.
      throw new ApiError(422, 'This quote asks for a deposit — convert it to an order');
    }
    const documentDate = input.documentDate ?? (await orgTodayOnClient(client, orgId));
    let dueDate: string | undefined = input.dueDate ?? undefined;
    if (dueDate === undefined && quote.paymentTermsCode === null) {
      const defaults = await invoiceSettingsService.getQuoteDefaultsOnClient(client, orgId);
      dueDate = addDaysIso(documentDate, defaults.defaultDueDays);
    }

    let result: { kind: 'INVOICE' | 'BILL'; id: string };
    if (direction === 'SALES') {
      const invoiceId = await invoiceService.createInvoiceOnClient(
        client,
        orgId,
        userId,
        {
          customerId: quote.partyId,
          issueDate: documentDate,
          dueDate,
          currencyCode: quote.currencyCode,
          notes: quote.notes,
          paymentTerms: quote.paymentTerms,
          paymentTermsCode: quote.paymentTermsCode,
          lines: quote.lines.map((l) => ({
            description: l.description,
            quantityMilli: l.quantityMilli,
            unitPriceCents: l.unitPriceCents,
            revenueAccountId: l.accountId,
            taxRateBp: l.taxRateBp,
            itemId: l.itemId,
            stockLocationId: null,
          })),
        },
        { sourceQuoteId: id },
      );
      result = { kind: 'INVOICE', id: invoiceId };
    } else {
      if (quote.quoteNumber === null) throw new Error(`Accepted quote ${id} has no number`);
      const billId = await billService.createBillOnClient(
        client,
        orgId,
        userId,
        {
          vendorId: quote.partyId,
          vendorReference: input.vendorReference ?? quote.partyReference ?? quote.quoteNumber,
          billDate: documentDate,
          dueDate,
          currencyCode: quote.currencyCode,
          notes: quote.notes,
          paymentTerms: quote.paymentTerms,
          paymentTermsCode: quote.paymentTermsCode,
          lines: quote.lines.map((l) => ({
            description: l.description,
            quantityMilli: l.quantityMilli,
            unitPriceCents: l.unitPriceCents,
            expenseAccountId: l.accountId,
            taxRateBp: l.taxRateBp,
            itemId: l.itemId,
            stockLocationId: null,
          })),
        },
        { sourceQuoteId: id },
      );
      result = { kind: 'BILL', id: billId };
    }

    await transitionQuoteOnClient(client, orgId, id, 'CONVERTED', { userId });
    await emitEvent(client, orgId, MODULE_TAGS.accounting, 'quote.converted', {
      quoteId: id,
      direction,
      quoteNumber: quote.quoteNumber,
      documentKind: result.kind,
      documentId: result.id,
    });
    return result;
  });
}

// ------------------------------------------------------------------- expiry

/**
 * Worker only — the organizations holding SENT quotes past their validity.
 * A documented cross-tenant system read (like recurringService's due
 * schedules): it returns only org ids, and each org is then expired inside
 * its own org-scoped transaction.
 */
export async function listOrgsWithExpiredSentQuotes(): Promise<string[]> {
  const { rows } = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM quotes WHERE status = 'SENT' AND valid_until < ($1::date + 1)`,
    [new Date().toISOString().slice(0, 10)],
  );
  return rows.map((r) => r.org_id);
}

/**
 * Persists EXPIRED on one org's SENT quotes past validity. SKIP LOCKED: a
 * quote someone is accepting right now is left for the next sweep (and the
 * accept itself re-checks the date). Reads already show these as EXPIRED.
 */
export async function expireQuotesForOrg(orgId: string): Promise<number> {
  return withTransaction(async (client) => {
    const orgToday = await orgTodayOnClient(client, orgId);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM quotes
        WHERE org_id = $1 AND status = 'SENT' AND valid_until < $2::date
        ORDER BY id
        FOR UPDATE SKIP LOCKED`,
      [orgId, orgToday],
    );
    for (const row of rows) {
      await transitionQuoteOnClient(client, orgId, row.id, 'EXPIRED');
    }
    return rows.length;
  });
}

// Re-exported for publicQuoteService, which resolves a token to a quote and
// then works on the same org-scoped helpers.
export { loadLines as loadQuoteLinesOnClient };
