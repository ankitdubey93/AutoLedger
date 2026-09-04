import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import type { InvoiceSettings } from '../../types/ledger-core.js';

/**
 * LedgerCore invoice settings — numbering, defaults, and branding.
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

/** Mirrors migration 007's column DEFAULTs — the one place both sides read from. */
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
    configured: true,
  };
}

/** GET /ledger-core/settings/invoicing. No row is not a 404 — it means "never configured". */
export async function getInvoiceSettings(orgId: string): Promise<InvoiceSettings> {
  const { rows } = await pool.query<SettingsRow>(
    `SELECT number_prefix, number_padding, next_number, default_due_days, default_tax_rate_bp,
            tax_label, receivable_account_id, default_revenue_account_id, tax_payable_account_id,
            show_tax_number, show_business_number, show_legal_name,
            billing_address, payment_terms, footer_notes, accent_color
       FROM ledger_invoice_settings
      WHERE org_id = $1`,
    [orgId],
  );

  const row = rows[0];
  if (row === undefined) return { ...INVOICE_SETTINGS_DEFAULTS, configured: false };
  return toInvoiceSettings(row);
}

/** PATCH /ledger-core/settings/invoicing. Creates the row on first write. */
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
    await withTransaction((client) =>
      client.query(
        `INSERT INTO ledger_invoice_settings (org_id, ${columns.join(', ')})
         VALUES ($1, ${placeholders.join(', ')})
         ON CONFLICT (org_id) DO UPDATE SET ${updateAssignments.join(', ')}`,
        [orgId, ...insertValues],
      ),
    );
  } catch (err) {
    const constraint = pgConstraint(err);
    if (
      pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION &&
      (constraint === 'fk_invoice_settings_receivable_account' ||
        constraint === 'fk_invoice_settings_revenue_account' ||
        constraint === 'fk_invoice_settings_tax_account')
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
