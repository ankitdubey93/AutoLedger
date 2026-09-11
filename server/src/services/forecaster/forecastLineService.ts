import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import * as accountService from '../ledger-core/accountService.js';
import * as driverService from './driverService.js';
import type { ForecasterForecastLine, ForecasterLineKind } from '../../types/forecaster.js';
import type { BuildLine } from '../../utils/forecasterBuild.js';

/**
 * ForecasterPro (Phase 13) — forecast lines, owning `forecaster_forecast_lines`.
 * Every account fact comes from `accountService`'s exported functions and
 * every driver fact from `driverService`'s — this file queries only its own
 * table (guardrails rule 16). `account_id` carries no `REFERENCES`
 * (migration 038's ruling); validity is enforced here via
 * `accountService.getAccountById`'s own cross-tenant 404.
 */

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface LineRow {
  id: string;
  plan_id: string;
  account_id: string;
  label: string;
  kind: ForecasterLineKind;
  quantity_driver_id: string | null;
  rate_driver_id: string | null;
  source_driver_id: string | null;
  percent_bps: number | null;
  fixed_cents: string | null;
  created_at: Date;
  updated_at: Date;
}

const LINE_COLUMNS = `id, plan_id, account_id, label, kind, quantity_driver_id, rate_driver_id,
                       source_driver_id, percent_bps, fixed_cents::text AS fixed_cents,
                       created_at, updated_at`;

async function verifyPlanBelongsToOrg(orgId: string, planId: string): Promise<void> {
  const { rows } = await pool.query('SELECT 1 FROM forecaster_plans WHERE org_id = $1 AND id = $2', [
    orgId,
    planId,
  ]);
  if (rows.length === 0) throw new ApiError(404, 'Plan not found');
}

async function accountLookup(orgId: string): Promise<Map<string, { code: string; name: string }>> {
  const accounts = await accountService.listAccounts(orgId, { includeInactive: true });
  return new Map(accounts.map((a) => [a.id, { code: a.code, name: a.name }]));
}

function toLine(row: LineRow, accounts: Map<string, { code: string; name: string }>): ForecasterForecastLine {
  const account = accounts.get(row.account_id);
  return {
    id: row.id,
    planId: row.plan_id,
    accountId: row.account_id,
    accountCode: account?.code ?? '',
    accountName: account?.name ?? '(unknown account)',
    label: row.label,
    kind: row.kind,
    quantityDriverId: row.quantity_driver_id,
    rateDriverId: row.rate_driver_id,
    sourceDriverId: row.source_driver_id,
    percentBps: row.percent_bps,
    fixedCents: row.fixed_cents === null ? null : Number(row.fixed_cents),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listLines(orgId: string, planId: string): Promise<ForecasterForecastLine[]> {
  await verifyPlanBelongsToOrg(orgId, planId);

  const { rows } = await pool.query<LineRow>(
    `SELECT ${LINE_COLUMNS}
       FROM forecaster_forecast_lines
      WHERE org_id = $1 AND plan_id = $2
      ORDER BY label ASC`,
    [orgId, planId],
  );

  const accounts = await accountLookup(orgId);
  return rows.map((row) => toLine(row, accounts));
}

export type CreateForecastLineInput =
  | { kind: 'DRIVER_PRODUCT'; accountId: string; label: string; quantityDriverId: string; rateDriverId: string }
  | { kind: 'DRIVER_PERCENT'; accountId: string; label: string; sourceDriverId: string; percentBps: number }
  | { kind: 'FIXED_CENTS'; accountId: string; label: string; fixedCents: number };

export type UpdateForecastLineInput = CreateForecastLineInput;

async function validateLineInput(orgId: string, planId: string, input: CreateForecastLineInput): Promise<void> {
  const account = await accountService.getAccountById(orgId, input.accountId);
  if (!account.isPostable || !account.isActive) {
    throw new ApiError(422, 'A forecast line must map to a postable, active account');
  }
  if (account.type !== 'Revenue' && account.type !== 'Expense') {
    throw new ApiError(422, 'A forecast line must map to a Revenue or Expense account');
  }

  async function checkDriver(driverId: string, expectedKind: 'COUNT' | 'CENTS', label: string): Promise<void> {
    const driver = await driverService.getDriverById(orgId, driverId);
    if (driver.kind !== expectedKind) {
      throw new ApiError(422, label);
    }
    if (driver.planId !== planId) {
      throw new ApiError(422, 'A forecast line may only reference drivers on its own plan');
    }
  }

  if (input.kind === 'DRIVER_PRODUCT') {
    await checkDriver(input.quantityDriverId, 'COUNT', 'A DRIVER_PRODUCT line needs a COUNT quantity driver');
    await checkDriver(input.rateDriverId, 'CENTS', 'A DRIVER_PRODUCT line needs a CENTS rate driver');
  } else if (input.kind === 'DRIVER_PERCENT') {
    await checkDriver(input.sourceDriverId, 'CENTS', 'A DRIVER_PERCENT line needs a CENTS source driver');
  }
}

export async function createLine(
  orgId: string,
  planId: string,
  input: CreateForecastLineInput,
): Promise<ForecasterForecastLine> {
  await verifyPlanBelongsToOrg(orgId, planId);
  await validateLineInput(orgId, planId, input);

  const quantityDriverId = input.kind === 'DRIVER_PRODUCT' ? input.quantityDriverId : null;
  const rateDriverId = input.kind === 'DRIVER_PRODUCT' ? input.rateDriverId : null;
  const sourceDriverId = input.kind === 'DRIVER_PERCENT' ? input.sourceDriverId : null;
  const percentBps = input.kind === 'DRIVER_PERCENT' ? input.percentBps : null;
  const fixedCents = input.kind === 'FIXED_CENTS' ? input.fixedCents : null;

  try {
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query<LineRow>(
        `INSERT INTO forecaster_forecast_lines
           (org_id, plan_id, account_id, label, kind, quantity_driver_id, rate_driver_id,
            source_driver_id, percent_bps, fixed_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${LINE_COLUMNS}`,
        [
          orgId,
          planId,
          input.accountId,
          input.label,
          input.kind,
          quantityDriverId,
          rateDriverId,
          sourceDriverId,
          percentBps,
          fixedCents,
        ],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('INSERT ... RETURNING produced no row');
      return r;
    });

    const accounts = await accountLookup(orgId);
    return toLine(row, accounts);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A forecast line with that label already exists on this plan');
    }
    throw err;
  }
}

export async function updateLine(
  orgId: string,
  id: string,
  input: UpdateForecastLineInput,
): Promise<ForecasterForecastLine> {
  const { rows: planRows } = await pool.query<{ plan_id: string }>(
    'SELECT plan_id FROM forecaster_forecast_lines WHERE org_id = $1 AND id = $2',
    [orgId, id],
  );
  const existing = planRows[0];
  if (existing === undefined) throw new ApiError(404, 'Forecast line not found');

  await validateLineInput(orgId, existing.plan_id, input);

  const quantityDriverId = input.kind === 'DRIVER_PRODUCT' ? input.quantityDriverId : null;
  const rateDriverId = input.kind === 'DRIVER_PRODUCT' ? input.rateDriverId : null;
  const sourceDriverId = input.kind === 'DRIVER_PERCENT' ? input.sourceDriverId : null;
  const percentBps = input.kind === 'DRIVER_PERCENT' ? input.percentBps : null;
  const fixedCents = input.kind === 'FIXED_CENTS' ? input.fixedCents : null;

  try {
    const row = await withTransaction(async (client) => {
      const { rows, rowCount } = await client.query<LineRow>(
        `UPDATE forecaster_forecast_lines
            SET account_id = $3, label = $4, kind = $5, quantity_driver_id = $6, rate_driver_id = $7,
                source_driver_id = $8, percent_bps = $9, fixed_cents = $10
          WHERE org_id = $1 AND id = $2
          RETURNING ${LINE_COLUMNS}`,
        [
          orgId,
          id,
          input.accountId,
          input.label,
          input.kind,
          quantityDriverId,
          rateDriverId,
          sourceDriverId,
          percentBps,
          fixedCents,
        ],
      );
      if (rowCount === 0) throw new ApiError(404, 'Forecast line not found');
      const r = rows[0];
      if (r === undefined) throw new Error('UPDATE ... RETURNING produced no row');
      return r;
    });

    const accounts = await accountLookup(orgId);
    return toLine(row, accounts);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A forecast line with that label already exists on this plan');
    }
    throw err;
  }
}

export async function deleteLine(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query(
      'DELETE FROM forecaster_forecast_lines WHERE org_id = $1 AND id = $2',
      [orgId, id],
    );
    if (result.rowCount === 0) throw new ApiError(404, 'Forecast line not found');
  });
}

/** For the engine. Raw spec rows, no account join. */
export async function listBuildLines(orgId: string, planId: string): Promise<BuildLine[]> {
  const { rows } = await pool.query<LineRow>(
    `SELECT ${LINE_COLUMNS}
       FROM forecaster_forecast_lines
      WHERE org_id = $1 AND plan_id = $2`,
    [orgId, planId],
  );
  return rows.map((row) => ({
    lineId: row.id,
    label: row.label,
    accountId: row.account_id,
    kind: row.kind,
    quantityDriverId: row.quantity_driver_id,
    rateDriverId: row.rate_driver_id,
    sourceDriverId: row.source_driver_id,
    percentBps: row.percent_bps,
    fixedCents: row.fixed_cents === null ? null : Number(row.fixed_cents),
  }));
}
