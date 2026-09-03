import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { fiscalYearBounds } from '../../utils/fiscalYear.js';
import { updateOrganization } from '../organizationService.js';
import type { LedgerSettings } from '../../types/ledger-core.js';

/**
 * LedgerCore onboarding and settings.
 *
 * `organizationName` and `baseCurrency` are read from `organizations` (a
 * platform table) and folded into `LedgerSettings` for display, but they are
 * only ever written by calling `organizationService.updateOrganization` —
 * never by a query against `organizations` in this file (guardrails rule 16:
 * this file owns `ledger_settings`, not `organizations`).
 *
 * The absence of a `ledger_settings` row means "onboarding not yet completed"
 * — there is no seed row and no backfill migration, unlike the default chart
 * of accounts. See migration 005's header comment.
 */

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
    return typeof err.message === 'string' ? err.message : 'Database rejected the settings';
  }
  return 'Database rejected the settings';
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface OnboardingInput {
  organizationName: string;
  legalName: string | null;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  booksStartDate: string;
  industry: string | null;
  timezone: string;
  cashAccountId: string | null;
}

export interface UpdateSettingsInput {
  legalName?: string | null | undefined;
  fiscalYearStartMonth?: number | undefined;
  fiscalYearStartDay?: number | undefined;
  booksStartDate?: string | undefined;
  industry?: string | null | undefined;
  timezone?: string | undefined;
  cashAccountId?: string | null | undefined;
}

interface SettingsRow {
  organization_name: string;
  base_currency: string;
  org_created_at: Date;
  legal_name: string | null;
  fiscal_year_start_month: number | null;
  fiscal_year_start_day: number | null;
  books_start_date: string | null;
  industry: string | null;
  timezone: string | null;
  cash_account_id: string | null;
  onboarded_at: Date | null;
  has_lines: boolean;
}

function toLedgerSettings(row: SettingsRow): LedgerSettings {
  const fiscalYearStartMonth = row.fiscal_year_start_month ?? 1;
  const fiscalYearStartDay = row.fiscal_year_start_day ?? 1;

  return {
    organizationName: row.organization_name,
    legalName: row.legal_name,
    baseCurrency: row.base_currency.trim(),
    fiscalYearStartMonth,
    fiscalYearStartDay,
    booksStartDate: row.books_start_date ?? row.org_created_at.toISOString().slice(0, 10),
    industry: row.industry,
    timezone: row.timezone ?? 'UTC',
    cashAccountId: row.cash_account_id,
    onboardedAt: row.onboarded_at === null ? null : row.onboarded_at.toISOString(),
    currentFiscalYear: fiscalYearBounds(fiscalYearStartMonth, fiscalYearStartDay, todayUtc()),
    baseCurrencyLocked: row.has_lines,
  };
}

const SETTINGS_SELECT = `
  SELECT o.name AS organization_name, o.base_currency, o.created_at AS org_created_at,
         s.legal_name, s.fiscal_year_start_month, s.fiscal_year_start_day,
         s.books_start_date, s.industry, s.timezone, s.cash_account_id, s.onboarded_at,
         EXISTS (SELECT 1 FROM ledger_lines l WHERE l.org_id = o.id) AS has_lines
    FROM organizations o
    LEFT JOIN ledger_settings s ON s.org_id = o.id
   WHERE o.id = $1`;

/** GET /ledger-core/settings. A missing `ledger_settings` row is not a 404 — it means "not yet onboarded". */
export async function getSettings(orgId: string): Promise<LedgerSettings> {
  const { rows } = await pool.query<SettingsRow>(SETTINGS_SELECT, [orgId]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Organization not found');
  return toLedgerSettings(row);
}

/**
 * Completes (or re-completes) LedgerCore onboarding for one organization.
 *
 * One `BEGIN…COMMIT` on one checked-out `client` (rule 5): the organization
 * update and the settings upsert commit or roll back together. Upsert, not
 * insert-or-409 — a double submit from the wizard must be harmless.
 */
export async function completeOnboarding(orgId: string, input: OnboardingInput): Promise<LedgerSettings> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ledger_lines.currency_code is stamped at write time and those rows are
    // immutable by trigger (0A000) — a retroactive base-currency change would
    // silently invalidate every report already produced. Same code, or no
    // lines yet, is fine.
    const { rows: currencyRows } = await client.query<{ base_currency: string; has_lines: boolean }>(
      `SELECT o.base_currency,
              EXISTS (SELECT 1 FROM ledger_lines l WHERE l.org_id = o.id) AS has_lines
         FROM organizations o
        WHERE o.id = $1`,
      [orgId],
    );
    const currencyRow = currencyRows[0];
    if (currencyRow === undefined) throw new ApiError(404, 'Organization not found');

    if (currencyRow.has_lines && currencyRow.base_currency.trim() !== input.baseCurrency) {
      throw new ApiError(422, 'Base currency cannot be changed once journal entries exist');
    }

    // `client`, never `pool`: a stray pool.query here would run on a different
    // connection and commit immediately, leaving `organizations` updated after
    // a rollback of the settings write (guardrails rule 5).
    await updateOrganization(
      orgId,
      { name: input.organizationName, baseCurrency: input.baseCurrency },
      client,
    );

    await client.query(
      `INSERT INTO ledger_settings
         (org_id, legal_name, fiscal_year_start_month, fiscal_year_start_day,
          books_start_date, industry, timezone, cash_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id) DO UPDATE SET
         legal_name = EXCLUDED.legal_name,
         fiscal_year_start_month = EXCLUDED.fiscal_year_start_month,
         fiscal_year_start_day = EXCLUDED.fiscal_year_start_day,
         books_start_date = EXCLUDED.books_start_date,
         industry = EXCLUDED.industry,
         timezone = EXCLUDED.timezone,
         cash_account_id = EXCLUDED.cash_account_id`,
      [
        orgId,
        input.legalName,
        input.fiscalYearStartMonth,
        input.fiscalYearStartDay,
        input.booksStartDate,
        input.industry,
        input.timezone,
        input.cashAccountId,
      ],
    );

    await client.query('COMMIT');
    return await getSettings(orgId);
  } catch (err) {
    await client.query('ROLLBACK');

    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION && pgConstraint(err) === 'fk_ledger_settings_cash_account') {
      throw new ApiError(422, 'Cash account does not exist in this organization');
    }
    if (pgErrorCode(err) === PG_CHECK_VIOLATION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  } finally {
    client.release();
  }
}

/** PATCH /ledger-core/settings. Refuses to write until onboarding has completed once. */
export async function updateSettings(orgId: string, input: UpdateSettingsInput): Promise<LedgerSettings> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    legalName: 'legal_name',
    fiscalYearStartMonth: 'fiscal_year_start_month',
    fiscalYearStartDay: 'fiscal_year_start_day',
    booksStartDate: 'books_start_date',
    industry: 'industry',
    timezone: 'timezone',
    cashAccountId: 'cash_account_id',
  } as const;

  const assignments: string[] = [];
  const values: unknown[] = [orgId];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
  }

  if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

  try {
    const { rows } = await pool.query<{ org_id: string }>(
      `UPDATE ledger_settings SET ${assignments.join(', ')} WHERE org_id = $1 RETURNING org_id`,
      values,
    );

    // Zero rows means there was no settings row to update — the wizard was
    // never completed. `rowCount` can be `null` on the `pg` types, which is
    // why this checks the returned row instead (matching accountService's
    // updateAccount).
    if (rows[0] === undefined) {
      throw new ApiError(409, 'Complete LedgerCore onboarding before changing settings');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION && pgConstraint(err) === 'fk_ledger_settings_cash_account') {
      throw new ApiError(422, 'Cash account does not exist in this organization');
    }
    if (pgErrorCode(err) === PG_CHECK_VIOLATION) {
      throw new ApiError(422, pgErrorMessage(err));
    }
    throw err;
  }

  return getSettings(orgId);
}
