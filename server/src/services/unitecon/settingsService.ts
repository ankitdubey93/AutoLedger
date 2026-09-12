import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import * as accountService from '../ledger-core/accountService.js';
import { ApiError } from '../../utils/apiError.js';
import type { UniteconSettings } from '../../types/unitecon.js';

/**
 * UnitEcon (Phase 14) — per-organization unit-economics configuration.
 *
 * `getSettings` reads defaults without ever writing: a row is created only
 * on the first `PATCH`, never implicitly on a `GET`.
 *
 * Account validity is asserted through `accountService.getAccountById`,
 * never a direct `SELECT ... FROM accounts` — the same rule-16 boundary
 * `unitecon_settings.account_id` carries no FK to enforce.
 */

const DEFAULT_GROSS_MARGIN_BPS = 7000;

async function readAcquisitionAccountIds(orgId: string): Promise<string[]> {
  const { rows } = await pool.query<{ account_id: string }>(
    'SELECT account_id FROM unitecon_acquisition_accounts WHERE org_id = $1 ORDER BY account_id ASC',
    [orgId],
  );
  return rows.map((r) => r.account_id);
}

export async function getSettings(orgId: string): Promise<UniteconSettings> {
  const { rows } = await pool.query<{ gross_margin_bps: number; updated_at: Date }>(
    'SELECT gross_margin_bps, updated_at FROM unitecon_settings WHERE org_id = $1',
    [orgId],
  );

  const acquisitionAccountIds = await readAcquisitionAccountIds(orgId);
  const settingsRow = rows[0];

  if (settingsRow === undefined) {
    return {
      grossMarginBps: DEFAULT_GROSS_MARGIN_BPS,
      acquisitionAccountIds,
      updatedAt: null,
    };
  }

  return {
    grossMarginBps: settingsRow.gross_margin_bps,
    acquisitionAccountIds,
    updatedAt: settingsRow.updated_at.toISOString(),
  };
}

export interface UpdateSettingsInput {
  grossMarginBps?: number | undefined;
  acquisitionAccountIds?: string[] | undefined;
}

export async function updateSettings(
  orgId: string,
  createdBy: string,
  input: UpdateSettingsInput,
): Promise<UniteconSettings> {
  if (input.acquisitionAccountIds !== undefined) {
    const seen = new Set<string>();
    for (const accountId of input.acquisitionAccountIds) {
      if (seen.has(accountId)) {
        throw new ApiError(400, 'acquisitionAccountIds must not contain duplicates');
      }
      seen.add(accountId);

      // Throws 404 for an unknown or cross-org id — the tenancy check.
      const account = await accountService.getAccountById(orgId, accountId);
      if (account.type !== 'Expense') {
        throw new ApiError(422, 'An acquisition account must be an Expense account');
      }
    }
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ gross_margin_bps: number; updated_at: Date }>(
      `INSERT INTO unitecon_settings (org_id, gross_margin_bps, created_by)
       VALUES ($1, COALESCE($2, 7000), $3)
       ON CONFLICT (org_id) DO UPDATE
         SET gross_margin_bps = COALESCE($2, unitecon_settings.gross_margin_bps)
       RETURNING gross_margin_bps, updated_at`,
      [orgId, input.grossMarginBps ?? null, createdBy],
    );

    if (input.acquisitionAccountIds !== undefined) {
      await client.query('DELETE FROM unitecon_acquisition_accounts WHERE org_id = $1', [orgId]);
      for (const accountId of input.acquisitionAccountIds) {
        await client.query(
          'INSERT INTO unitecon_acquisition_accounts (org_id, account_id) VALUES ($1, $2)',
          [orgId, accountId],
        );
      }
    }

    const { rows: acctRows } = await client.query<{ account_id: string }>(
      'SELECT account_id FROM unitecon_acquisition_accounts WHERE org_id = $1 ORDER BY account_id ASC',
      [orgId],
    );

    const settingsRow = rows[0];
    if (settingsRow === undefined) throw new Error('updateSettings: upsert returned no row');

    return {
      grossMarginBps: settingsRow.gross_margin_bps,
      acquisitionAccountIds: acctRows.map((r) => r.account_id),
      updatedAt: settingsRow.updated_at.toISOString(),
    };
  });
}
