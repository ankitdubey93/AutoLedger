import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import * as systemAccountService from './systemAccountService.js';
import type {
  InvoiceSettings,
  InvoiceTemplateId,
  InvoiceFontFamily,
  InvoiceDensity,
} from '../../types/accounting.js';

/**
 * Accounting invoice settings — numbering, defaults, and branding.
 *
 * The absence of a `ledger_invoice_settings` row means "never configured" —
 * `getInvoiceSettings` returns the same defaults migration 007's column
 * DEFAULTs carry, via `INVOICE_SETTINGS_DEFAULTS`, so the two cannot drift
 * apart silently. There is no seed row and no backfill, matching
 * `ledger_settings` (005).
 */

type Queryable = Pick<PoolClient, 'query'>;

const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

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
    return typeof err.message === 'string' ? err.message : 'Database rejected the invoice settings';
  }
  return 'Database rejected the invoice settings';
}

/** Mirrors migration 007 and 070's column DEFAULTs — the one place both sides read from. */
const INVOICE_SETTINGS_DEFAULTS: Omit<InvoiceSettings, 'configured'> = {
  numberPrefix: 'INV-',
  numberPadding: 6,
  nextNumber: 1,
  defaultDueDays: 30,
  defaultTaxRateBp: 0,
  taxLabel: 'Tax',
  receivableAccountId: null,
  defaultRevenueAccountId: null,
  taxPayableAccountId: null,
  showTaxNumber: true,
  showBusinessNumber: false,
  showLegalName: true,
  billingAddress: null,
  paymentTerms: null,
  footerNotes: null,
  accentColor: '#2563eb',
  templateId: 'classic',
  documentTitle: 'INVOICE',
  fontFamily: 'sans',
  density: 'comfortable',
  showLogo: true,
  showOrgAddress: true,
  showPaymentTerms: true,
  showDueDate: true,
  bankDetails: null,
  quotePrefix: 'QU-',
  quoteNextNumber: 1,
  purchaseQuotePrefix: 'PQ-',
  purchaseQuoteNextNumber: 1,
  defaultQuoteValidityDays: 30,
  defaultQuoteTerms: null,
  quoteAcceptanceRequiresCode: false,
  customerDepositAccountId: null,
  supplierPrepaymentAccountId: null,
};

export interface UpdateInvoiceSettingsInput {
  numberPrefix?: string | undefined;
  numberPadding?: number | undefined;
  nextNumber?: number | undefined;
  defaultDueDays?: number | undefined;
  defaultTaxRateBp?: number | undefined;
  taxLabel?: string | undefined;
  receivableAccountId?: string | null | undefined;
  defaultRevenueAccountId?: string | null | undefined;
  taxPayableAccountId?: string | null | undefined;
  showTaxNumber?: boolean | undefined;
  showBusinessNumber?: boolean | undefined;
  showLegalName?: boolean | undefined;
  billingAddress?: string | null | undefined;
  paymentTerms?: string | null | undefined;
  footerNotes?: string | null | undefined;
  accentColor?: string | undefined;
  templateId?: InvoiceTemplateId | undefined;
  documentTitle?: string | undefined;
  fontFamily?: InvoiceFontFamily | undefined;
  density?: InvoiceDensity | undefined;
  showLogo?: boolean | undefined;
  showOrgAddress?: boolean | undefined;
  showPaymentTerms?: boolean | undefined;
  showDueDate?: boolean | undefined;
  bankDetails?: string | null | undefined;
  quotePrefix?: string | undefined;
  quoteNextNumber?: number | undefined;
  purchaseQuotePrefix?: string | undefined;
  purchaseQuoteNextNumber?: number | undefined;
  defaultQuoteValidityDays?: number | undefined;
  defaultQuoteTerms?: string | null | undefined;
  quoteAcceptanceRequiresCode?: boolean | undefined;
  customerDepositAccountId?: string | null | undefined;
  supplierPrepaymentAccountId?: string | null | undefined;
}

interface SettingsRow {
  number_prefix: string;
  number_padding: number;
  next_number: number;
  default_due_days: number;
  default_tax_rate_bp: number;
  tax_label: string;
  receivable_account_id: string | null;
  default_revenue_account_id: string | null;
  tax_payable_account_id: string | null;
  show_tax_number: boolean;
  show_business_number: boolean;
  show_legal_name: boolean;
  billing_address: string | null;
  payment_terms: string | null;
  footer_notes: string | null;
  accent_color: string;
  template_id: InvoiceTemplateId;
  document_title: string;
  font_family: InvoiceFontFamily;
  density: InvoiceDensity;
  show_logo: boolean;
  show_org_address: boolean;
  show_payment_terms: boolean;
  show_due_date: boolean;
  bank_details: string | null;
  quote_prefix: string;
  quote_next_number: number;
  purchase_quote_prefix: string;
  purchase_quote_next_number: number;
  default_quote_validity_days: number;
  default_quote_terms: string | null;
  quote_acceptance_requires_code: boolean;
  customer_deposit_account_id: string | null;
  supplier_prepayment_account_id: string | null;
}

function toInvoiceSettings(row: SettingsRow): InvoiceSettings {
  return {
    numberPrefix: row.number_prefix,
    numberPadding: row.number_padding,
    nextNumber: row.next_number,
    defaultDueDays: row.default_due_days,
    defaultTaxRateBp: row.default_tax_rate_bp,
    taxLabel: row.tax_label,
    receivableAccountId: row.receivable_account_id,
    defaultRevenueAccountId: row.default_revenue_account_id,
    taxPayableAccountId: row.tax_payable_account_id,
    showTaxNumber: row.show_tax_number,
    showBusinessNumber: row.show_business_number,
    showLegalName: row.show_legal_name,
    billingAddress: row.billing_address,
    paymentTerms: row.payment_terms,
    footerNotes: row.footer_notes,
    accentColor: row.accent_color,
    templateId: row.template_id,
    documentTitle: row.document_title,
    fontFamily: row.font_family,
    density: row.density,
    showLogo: row.show_logo,
    showOrgAddress: row.show_org_address,
    showPaymentTerms: row.show_payment_terms,
    showDueDate: row.show_due_date,
    bankDetails: row.bank_details,
    quotePrefix: row.quote_prefix,
    quoteNextNumber: row.quote_next_number,
    purchaseQuotePrefix: row.purchase_quote_prefix,
    purchaseQuoteNextNumber: row.purchase_quote_next_number,
    defaultQuoteValidityDays: row.default_quote_validity_days,
    defaultQuoteTerms: row.default_quote_terms,
    quoteAcceptanceRequiresCode: row.quote_acceptance_requires_code,
    customerDepositAccountId: row.customer_deposit_account_id,
    supplierPrepaymentAccountId: row.supplier_prepayment_account_id,
    configured: true,
  };
}

/** GET /settings/invoicing. No row is not a 404 — it means "never configured". */
export async function getInvoiceSettings(orgId: string): Promise<InvoiceSettings> {
  const { rows } = await pool.query<SettingsRow>(
    `SELECT number_prefix, number_padding, next_number, default_due_days, default_tax_rate_bp,
            tax_label, receivable_account_id, default_revenue_account_id, tax_payable_account_id,
            show_tax_number, show_business_number, show_legal_name,
            billing_address, payment_terms, footer_notes, accent_color,
            template_id, document_title, font_family, density, show_logo, show_org_address,
            show_payment_terms, show_due_date, bank_details,
            quote_prefix, quote_next_number, purchase_quote_prefix, purchase_quote_next_number,
            default_quote_validity_days, default_quote_terms, quote_acceptance_requires_code,
            customer_deposit_account_id, supplier_prepayment_account_id
       FROM ledger_invoice_settings
      WHERE org_id = $1`,
    [orgId],
  );

  const row = rows[0];
  if (row === undefined) return { ...INVOICE_SETTINGS_DEFAULTS, configured: false };
  return toInvoiceSettings(row);
}

/** PATCH /settings/invoicing. Creates the row on first write. */
export async function updateInvoiceSettings(
  orgId: string,
  input: UpdateInvoiceSettingsInput,
): Promise<InvoiceSettings> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    numberPrefix: 'number_prefix',
    numberPadding: 'number_padding',
    nextNumber: 'next_number',
    defaultDueDays: 'default_due_days',
    defaultTaxRateBp: 'default_tax_rate_bp',
    taxLabel: 'tax_label',
    receivableAccountId: 'receivable_account_id',
    defaultRevenueAccountId: 'default_revenue_account_id',
    taxPayableAccountId: 'tax_payable_account_id',
    showTaxNumber: 'show_tax_number',
    showBusinessNumber: 'show_business_number',
    showLegalName: 'show_legal_name',
    billingAddress: 'billing_address',
    paymentTerms: 'payment_terms',
    footerNotes: 'footer_notes',
    accentColor: 'accent_color',
    templateId: 'template_id',
    documentTitle: 'document_title',
    fontFamily: 'font_family',
    density: 'density',
    showLogo: 'show_logo',
    showOrgAddress: 'show_org_address',
    showPaymentTerms: 'show_payment_terms',
    showDueDate: 'show_due_date',
    bankDetails: 'bank_details',
    quotePrefix: 'quote_prefix',
    quoteNextNumber: 'quote_next_number',
    purchaseQuotePrefix: 'purchase_quote_prefix',
    purchaseQuoteNextNumber: 'purchase_quote_next_number',
    defaultQuoteValidityDays: 'default_quote_validity_days',
    defaultQuoteTerms: 'default_quote_terms',
    quoteAcceptanceRequiresCode: 'quote_acceptance_requires_code',
    customerDepositAccountId: 'customer_deposit_account_id',
    supplierPrepaymentAccountId: 'supplier_prepayment_account_id',
  } as const;

  const columns: string[] = [];
  const insertValues: unknown[] = [];
  const updateAssignments: string[] = [];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    columns.push(COLUMNS[key]);
    insertValues.push(value);
    updateAssignments.push(`${COLUMNS[key]} = EXCLUDED.${COLUMNS[key]}`);
  }

  if (columns.length === 0) throw new ApiError(400, 'No fields to update');

  const placeholders = insertValues.map((_, i) => `$${String(i + 2)}`);

  try {
    await withTransaction(async (client) => {
      // Phase 46a — a retired account cannot be pointed at by a setting.
      await systemAccountService.assertActiveAccountsOnClient(client, orgId, [
        input.receivableAccountId,
        input.defaultRevenueAccountId,
        input.taxPayableAccountId,
        input.customerDepositAccountId,
        input.supplierPrepaymentAccountId,
      ]);
      await client.query(
        `INSERT INTO ledger_invoice_settings (org_id, ${columns.join(', ')})
         VALUES ($1, ${placeholders.join(', ')})
         ON CONFLICT (org_id) DO UPDATE SET ${updateAssignments.join(', ')}`,
        [orgId, ...insertValues],
      );
    });
  } catch (err) {
    const constraint = pgConstraint(err);
    if (
      pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION &&
      (constraint === 'fk_invoice_settings_receivable_account' ||
        constraint === 'fk_invoice_settings_revenue_account' ||
        constraint === 'fk_invoice_settings_tax_account' ||
        constraint === 'fk_ledger_invoice_settings_customer_deposit_account' ||
        constraint === 'fk_ledger_invoice_settings_supplier_prepayment_account')
    ) {
      throw new ApiError(422, 'Account does not exist in this organization');
    }
    if (pgErrorCode(err) === PG_CHECK_VIOLATION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  }

  return getInvoiceSettings(orgId);
}

/**
 * Allocates the next invoice number on the caller's checked-out transaction
 * client (guardrails rule 5) — never `pool`. The row lock the UPDATE takes
 * serializes concurrent issuers, so two invoices can never be allocated the
 * same number. Gaps are possible if the surrounding transaction rolls back;
 * that is accepted, not a bug.
 */
export async function allocateInvoiceNumber(client: Queryable, orgId: string): Promise<string> {
  await client.query(
    'INSERT INTO ledger_invoice_settings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING',
    [orgId],
  );

  const { rows } = await client.query<{
    allocated: number;
    number_prefix: string;
    number_padding: number;
  }>(
    `UPDATE ledger_invoice_settings
        SET next_number = next_number + 1
      WHERE org_id = $1
      RETURNING next_number - 1 AS allocated, number_prefix, number_padding`,
    [orgId],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('invoice settings row missing after upsert');

  return `${row.number_prefix}${String(row.allocated).padStart(row.number_padding, '0')}`;
}

/** Largest numeric part an imported number may advance the counter to (next_number is an INTEGER). */
const MAX_ADVANCE_NUMBER = 2_000_000_000;

/**
 * Phase 36d — after an import reserves externally-supplied invoice numbers,
 * moves the sequence past any that look like `${number_prefix}<digits>` so a
 * later allocation can never collide. Locks the settings row first (the same
 * lock allocateInvoiceNumber's UPDATE takes) and only ever raises next_number.
 * Runs on the caller's transaction client (rule 5).
 */
export async function advancePastImportedNumbersOnClient(
  client: Queryable,
  orgId: string,
  numbers: readonly string[],
): Promise<void> {
  await client.query(
    'INSERT INTO ledger_invoice_settings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING',
    [orgId],
  );
  const { rows } = await client.query<{ number_prefix: string }>(
    'SELECT number_prefix FROM ledger_invoice_settings WHERE org_id = $1 FOR UPDATE',
    [orgId],
  );
  const prefix = rows[0]?.number_prefix;
  if (prefix === undefined) throw new Error('invoice settings row missing after upsert');

  let max = 0;
  for (const number of numbers) {
    if (!number.startsWith(prefix)) continue;
    const rest = number.slice(prefix.length);
    if (!/^[0-9]+$/.test(rest)) continue;
    const n = Number(rest);
    if (n > MAX_ADVANCE_NUMBER) continue;
    if (n > max) max = n;
  }
  if (max === 0) return;

  await client.query(
    'UPDATE ledger_invoice_settings SET next_number = GREATEST(next_number, $2::int + 1) WHERE org_id = $1',
    [orgId, max],
  );
}

/**
 * Phase 26 — credit and debit notes each keep their own gapless series
 * (`CN-000001`, `DN-000001`) on the same settings row, allocated exactly like
 * the invoice number: inside the issuing transaction, so a rollback un-burns
 * the number. Phase 41 adds the sales (`QU-`) and purchase (`PQ-`) quote
 * series, allocated at a quote's first send. The identifiers interpolated
 * below come only from this constant map, never request input (guardrails
 * rule 4).
 */
const SERIES_COUNTER = {
  CREDIT_NOTE: { prefix: 'credit_note_prefix', next: 'credit_note_next_number' },
  DEBIT_NOTE: { prefix: 'debit_note_prefix', next: 'debit_note_next_number' },
  SALES_QUOTE: { prefix: 'quote_prefix', next: 'quote_next_number' },
  PURCHASE_QUOTE: { prefix: 'purchase_quote_prefix', next: 'purchase_quote_next_number' },
  SALES_ORDER: { prefix: 'order_prefix', next: 'order_next_number' },
  PURCHASE_ORDER: { prefix: 'purchase_order_prefix', next: 'purchase_order_next_number' },
} as const;

type SeriesKind = keyof typeof SERIES_COUNTER;

async function allocateSeriesNumber(client: Queryable, orgId: string, kind: SeriesKind): Promise<string> {
  const counter = SERIES_COUNTER[kind];

  await client.query(
    'INSERT INTO ledger_invoice_settings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING',
    [orgId],
  );

  const { rows } = await client.query<{ allocated: number; prefix: string; number_padding: number }>(
    `UPDATE ledger_invoice_settings
        SET ${counter.next} = ${counter.next} + 1
      WHERE org_id = $1
      RETURNING ${counter.next} - 1 AS allocated, ${counter.prefix} AS prefix, number_padding`,
    [orgId],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('invoice settings row missing after upsert');

  return `${row.prefix}${String(row.allocated).padStart(row.number_padding, '0')}`;
}

export async function allocateNoteNumber(
  client: Queryable,
  orgId: string,
  kind: 'CREDIT_NOTE' | 'DEBIT_NOTE',
): Promise<string> {
  return allocateSeriesNumber(client, orgId, kind);
}

/** Phase 41 — a quote's number, allocated once at its first send; a revision inherits it. */
export async function allocateQuoteNumber(
  client: Queryable,
  orgId: string,
  direction: 'SALES' | 'PURCHASE',
): Promise<string> {
  return allocateSeriesNumber(client, orgId, direction === 'SALES' ? 'SALES_QUOTE' : 'PURCHASE_QUOTE');
}

/** Phase 42 — an order's number, allocated at confirmation (a deleted draft burns no number). */
export async function allocateOrderNumber(
  client: Queryable,
  orgId: string,
  direction: 'SALES' | 'PURCHASE',
): Promise<string> {
  return allocateSeriesNumber(client, orgId, direction === 'SALES' ? 'SALES_ORDER' : 'PURCHASE_ORDER');
}

/** Mirrors migrations 007 and 089's column DEFAULTs, for an org with no settings row yet. */
const QUOTE_DEFAULTS = { validityDays: 30, terms: null, defaultDueDays: 30 } as const;

/**
 * Phase 41 — how long a new quote stays open, the terms a new quote starts
 * with, and the due days a converted document falls back to when the quote
 * carries no payment term.
 */
export async function getQuoteDefaultsOnClient(
  client: Queryable,
  orgId: string,
): Promise<{ validityDays: number; terms: string | null; defaultDueDays: number }> {
  const { rows } = await client.query<{
    default_quote_validity_days: number;
    default_quote_terms: string | null;
    default_due_days: number;
  }>(
    `SELECT default_quote_validity_days, default_quote_terms, default_due_days
       FROM ledger_invoice_settings WHERE org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) return { ...QUOTE_DEFAULTS };
  return {
    validityDays: row.default_quote_validity_days,
    terms: row.default_quote_terms,
    defaultDueDays: row.default_due_days,
  };
}
