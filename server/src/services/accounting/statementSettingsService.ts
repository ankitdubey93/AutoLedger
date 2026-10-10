import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import type { InvoiceTemplateId, StatementSettings, StatementType } from '../../types/accounting.js';

/**
 * Statement template settings (Phase 39a) — the statement counterpart of the
 * invoice template half of `invoiceSettingsService`.
 *
 * No `ledger_statement_settings` row means "never configured":
 * `getStatementSettings` returns `STATEMENT_SETTINGS_DEFAULTS`, which mirror
 * migration 084's column DEFAULTs so the two cannot drift silently.
 */

const PG_CHECK_VIOLATION = '23514';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return 'Database rejected the statement settings';
}

const STATEMENT_SETTINGS_DEFAULTS: Omit<StatementSettings, 'configured'> = {
  templateId: 'classic',
  documentTitle: 'STATEMENT',
  defaultType: 'OUTSTANDING',
  showLogo: true,
  showOrgAddress: true,
  showAgingSummary: true,
  showRemittance: true,
  footerNotes: null,
  accentColor: '#2563eb',
};

export interface UpdateStatementSettingsInput {
  templateId?: InvoiceTemplateId | undefined;
  documentTitle?: string | undefined;
  defaultType?: StatementType | undefined;
  showLogo?: boolean | undefined;
  showOrgAddress?: boolean | undefined;
  showAgingSummary?: boolean | undefined;
  showRemittance?: boolean | undefined;
  footerNotes?: string | null | undefined;
  accentColor?: string | undefined;
}

interface SettingsRow {
  template_id: InvoiceTemplateId;
  document_title: string;
  default_type: StatementType;
  show_logo: boolean;
  show_org_address: boolean;
  show_aging_summary: boolean;
  show_remittance: boolean;
  footer_notes: string | null;
  accent_color: string;
}

/** GET /settings/statements. No row is not a 404 — it means "never configured". */
export async function getStatementSettings(orgId: string): Promise<StatementSettings> {
  const { rows } = await pool.query<SettingsRow>(
    `SELECT template_id, document_title, default_type, show_logo, show_org_address,
            show_aging_summary, show_remittance, footer_notes, accent_color
       FROM ledger_statement_settings
      WHERE org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) return { ...STATEMENT_SETTINGS_DEFAULTS, configured: false };
  return {
    templateId: row.template_id,
    documentTitle: row.document_title,
    defaultType: row.default_type,
    showLogo: row.show_logo,
    showOrgAddress: row.show_org_address,
    showAgingSummary: row.show_aging_summary,
    showRemittance: row.show_remittance,
    footerNotes: row.footer_notes,
    accentColor: row.accent_color,
    configured: true,
  };
}

/** PATCH /settings/statements. Creates the row on first write. */
export async function updateStatementSettings(
  orgId: string,
  input: UpdateStatementSettingsInput,
): Promise<StatementSettings> {
  // Column names come from this frozen map, never from the request (rule 4).
  const COLUMNS = {
    templateId: 'template_id',
    documentTitle: 'document_title',
    defaultType: 'default_type',
    showLogo: 'show_logo',
    showOrgAddress: 'show_org_address',
    showAgingSummary: 'show_aging_summary',
    showRemittance: 'show_remittance',
    footerNotes: 'footer_notes',
    accentColor: 'accent_color',
  } as const;

  const columns: string[] = [];
  const values: unknown[] = [];
  const assignments: string[] = [];
  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    columns.push(COLUMNS[key]);
    values.push(value);
    assignments.push(`${COLUMNS[key]} = EXCLUDED.${COLUMNS[key]}`);
  }
  if (columns.length === 0) throw new ApiError(400, 'No fields to update');

  const placeholders = values.map((_, i) => `$${String(i + 2)}`);
  try {
    await withTransaction((client) =>
      client.query(
        `INSERT INTO ledger_statement_settings (org_id, ${columns.join(', ')})
         VALUES ($1, ${placeholders.join(', ')})
         ON CONFLICT (org_id) DO UPDATE SET ${assignments.join(', ')}`,
        [orgId, ...values],
      ),
    );
  } catch (err) {
    if (pgErrorCode(err) === PG_CHECK_VIOLATION) throw new ApiError(422, pgErrorMessage(err));
    throw err;
  }
  return getStatementSettings(orgId);
}
