import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import * as accountService from '../ledger-core/accountService.js';
import * as forecastService from './forecastService.js';
import {
  canTransitionForecasterBudget,
  type ForecasterBudgetLine,
  type ForecasterBudgetLineSource,
  type ForecasterBudgetStatus,
  type ForecasterBudgetVersion,
  type ForecasterBudgetVersionDetail,
} from '../../types/forecaster.js';

/**
 * ForecasterPro (Phase 13) — zero-based budget versions and their lines.
 * `compileVersion` materializes the forecast build-up (`forecastService`)
 * into DRIVER/HEADCOUNT lines, preserving any hand-entered MANUAL lines.
 * `approveVersion` freezes the version once, superseding any prior
 * approved version on the same plan — the one exception to "ForecasterPro
 * posts nothing to the GL" that still gets an immutability rule, because an
 * approved budget is a decision of record (migration 039's ruling).
 *
 * Every account fact comes from `accountService`'s exported functions
 * (guardrails rule 16) — this file queries only its own tables.
 */

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface VersionRow {
  id: string;
  plan_id: string;
  label: string;
  status: ForecasterBudgetStatus;
  created_by: string;
  created_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  line_count: string;
  total_cents: string | null;
  created_at: Date;
  updated_at: Date;
}

const VERSION_SELECT = `
  SELECT v.id, v.plan_id, v.label, v.status, v.created_by, cu.name AS created_by_name,
         v.approved_by, au.name AS approved_by_name, v.approved_at, v.created_at, v.updated_at,
         COALESCE(l.line_count, 0) AS line_count, l.total_cents
    FROM forecaster_budget_versions v
    LEFT JOIN users cu ON cu.id = v.created_by
    LEFT JOIN users au ON au.id = v.approved_by
    LEFT JOIN (
      SELECT org_id, version_id, COUNT(*) AS line_count, SUM(amount_cents)::text AS total_cents
        FROM forecaster_budget_lines
       GROUP BY org_id, version_id
    ) l ON l.org_id = v.org_id AND l.version_id = v.id`;

function toVersion(row: VersionRow): ForecasterBudgetVersion {
  return {
    id: row.id,
    planId: row.plan_id,
    label: row.label,
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? '(unknown user)',
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at === null ? null : row.approved_at.toISOString(),
    lineCount: Number(row.line_count),
    totalCents: row.total_cents === null ? 0 : Number(row.total_cents),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface LineRow {
  id: string;
  version_id: string;
  account_id: string;
  month: string;
  amount_cents: string;
  source: ForecasterBudgetLineSource;
  justification: string;
  created_at: Date;
  updated_at: Date;
}

const LINE_COLUMNS = `id, version_id, account_id, month::text AS month, amount_cents::text AS amount_cents,
                       source, justification, created_at, updated_at`;

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

function toLine(row: LineRow, accounts: Map<string, { code: string; name: string }>): ForecasterBudgetLine {
  const account = accounts.get(row.account_id);
  return {
    id: row.id,
    versionId: row.version_id,
    accountId: row.account_id,
    accountCode: account?.code ?? '',
    accountName: account?.name ?? '(unknown account)',
    month: row.month,
    amountCents: Number(row.amount_cents),
    source: row.source,
    justification: row.justification,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function getVersionRow(orgId: string, id: string): Promise<{ planId: string; status: ForecasterBudgetStatus }> {
  const { rows } = await pool.query<{ plan_id: string; status: ForecasterBudgetStatus }>(
    'SELECT plan_id, status FROM forecaster_budget_versions WHERE org_id = $1 AND id = $2',
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Budget version not found');
  return { planId: row.plan_id, status: row.status };
}

export async function listVersions(orgId: string, planId: string): Promise<ForecasterBudgetVersion[]> {
  await verifyPlanBelongsToOrg(orgId, planId);

  const { rows } = await pool.query<VersionRow>(
    `${VERSION_SELECT}
    WHERE v.org_id = $1 AND v.plan_id = $2
    ORDER BY v.created_at DESC`,
    [orgId, planId],
  );
  return rows.map(toVersion);
}

export async function getVersionById(orgId: string, id: string): Promise<ForecasterBudgetVersionDetail> {
  const { rows } = await pool.query<VersionRow>(
    `${VERSION_SELECT}
    WHERE v.org_id = $1 AND v.id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Budget version not found');

  const { rows: lineRows } = await pool.query<LineRow>(
    `SELECT ${LINE_COLUMNS}
       FROM forecaster_budget_lines
      WHERE org_id = $1 AND version_id = $2
      ORDER BY month ASC, account_id ASC`,
    [orgId, id],
  );

  const accounts = await accountLookup(orgId);
  return { ...toVersion(row), lines: lineRows.map((r) => toLine(r, accounts)) };
}

export async function createVersion(
  orgId: string,
  planId: string,
  createdBy: string,
  input: { label: string },
): Promise<ForecasterBudgetVersionDetail> {
  await verifyPlanBelongsToOrg(orgId, planId);

  try {
    const newId = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO forecaster_budget_versions (org_id, plan_id, label, status, created_by)
         VALUES ($1, $2, $3, 'DRAFT', $4)
         RETURNING id`,
        [orgId, planId, input.label, createdBy],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('INSERT ... RETURNING id returned no row');
      return id;
    });

    return await getVersionById(orgId, newId);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A budget version with that label already exists on this plan');
    }
    throw err;
  }
}

export async function deleteVersion(orgId: string, id: string): Promise<void> {
  const { status } = await getVersionRow(orgId, id);
  if (status !== 'DRAFT') {
    throw new ApiError(409, 'Only a DRAFT budget version can be deleted');
  }

  await withTransaction(async (client) => {
    const result = await client.query(
      'DELETE FROM forecaster_budget_versions WHERE org_id = $1 AND id = $2',
      [orgId, id],
    );
    if (result.rowCount === 0) throw new ApiError(404, 'Budget version not found');
  });
}

export async function compileVersion(orgId: string, id: string): Promise<ForecasterBudgetVersionDetail> {
  const { planId, status } = await getVersionRow(orgId, id);
  if (status !== 'DRAFT') {
    throw new ApiError(409, 'Only a DRAFT budget version can be compiled');
  }

  const forecast = await forecastService.buildPlanForecast(orgId, planId);

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM forecaster_budget_lines
        WHERE org_id = $1 AND version_id = $2 AND source IN ('DRIVER','HEADCOUNT')`,
      [orgId, id],
    );

    for (const month of forecast.build.months) {
      for (const line of month.lines) {
        if (line.amountCents === 0) continue;
        await client.query(
          `INSERT INTO forecaster_budget_lines (org_id, version_id, account_id, month, amount_cents, source, justification)
           VALUES ($1, $2, $3, $4::date, $5, 'DRIVER', $6)
           ON CONFLICT (org_id, version_id, account_id, month, source)
           DO UPDATE SET amount_cents = forecaster_budget_lines.amount_cents + EXCLUDED.amount_cents,
                         justification = EXCLUDED.justification`,
          [orgId, id, line.accountId, month.month, line.amountCents, `Compiled from forecast line "${line.label}"`],
        );
      }

      for (const role of month.roles) {
        await client.query(
          `INSERT INTO forecaster_budget_lines (org_id, version_id, account_id, month, amount_cents, source, justification)
           VALUES ($1, $2, $3, $4::date, $5, 'HEADCOUNT', $6)
           ON CONFLICT (org_id, version_id, account_id, month, source)
           DO UPDATE SET amount_cents = forecaster_budget_lines.amount_cents + EXCLUDED.amount_cents,
                         justification = EXCLUDED.justification`,
          [
            orgId,
            id,
            role.accountId,
            month.month,
            role.amountCents,
            `Compiled from headcount role "${role.title}" (${role.fteCount} FTE)`,
          ],
        );
      }
    }
  });

  return await getVersionById(orgId, id);
}

export async function approveVersion(
  orgId: string,
  id: string,
  approvedBy: string,
): Promise<ForecasterBudgetVersionDetail> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ plan_id: string; status: ForecasterBudgetStatus }>(
      'SELECT plan_id, status FROM forecaster_budget_versions WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const current = rows[0];
    if (current === undefined) throw new ApiError(404, 'Budget version not found');

    if (!canTransitionForecasterBudget(current.status, 'APPROVED')) {
      throw new ApiError(409, `Cannot move a budget version from ${current.status} to APPROVED`);
    }

    const { rows: countRows } = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM forecaster_budget_lines WHERE org_id = $1 AND version_id = $2',
      [orgId, id],
    );
    if ((countRows[0]?.count ?? '0') === '0') {
      throw new ApiError(422, 'A budget version must have at least one line before approval');
    }

    // Supersede the incumbent first, so ux_forecaster_budget_versions_one_approved
    // is never momentarily violated.
    await client.query(
      `UPDATE forecaster_budget_versions SET status = 'SUPERSEDED'
        WHERE org_id = $1 AND plan_id = $2 AND status = 'APPROVED'`,
      [orgId, current.plan_id],
    );

    await client.query(
      `UPDATE forecaster_budget_versions
          SET status = 'APPROVED', approved_by = $3, approved_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgId, id, approvedBy],
    );
  });

  return await getVersionById(orgId, id);
}

export interface CreateBudgetLineInput {
  accountId: string;
  month: string;
  amountCents: number;
  justification: string;
}

export interface UpdateBudgetLineInput {
  amountCents?: number | undefined;
  justification?: string | undefined;
}

async function verifyVersionIsDraft(orgId: string, versionId: string): Promise<void> {
  const { status } = await getVersionRow(orgId, versionId);
  if (status !== 'DRAFT') {
    throw new ApiError(409, 'Only a DRAFT budget version can be edited');
  }
}

export async function addLine(
  orgId: string,
  versionId: string,
  input: CreateBudgetLineInput,
): Promise<ForecasterBudgetLine> {
  await verifyVersionIsDraft(orgId, versionId);

  const account = await accountService.getAccountById(orgId, input.accountId);
  if (!account.isPostable || !account.isActive) {
    throw new ApiError(422, 'A budget line must map to a postable, active account');
  }

  try {
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query<LineRow>(
        `INSERT INTO forecaster_budget_lines (org_id, version_id, account_id, month, amount_cents, source, justification)
         VALUES ($1, $2, $3, $4::date, $5, 'MANUAL', $6)
         RETURNING ${LINE_COLUMNS}`,
        [orgId, versionId, input.accountId, input.month, input.amountCents, input.justification],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('INSERT ... RETURNING produced no row');
      return r;
    });

    const accounts = await accountLookup(orgId);
    return toLine(row, accounts);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A manual budget line already exists for that account and month');
    }
    throw err;
  }
}

export async function updateLine(
  orgId: string,
  lineId: string,
  input: UpdateBudgetLineInput,
): Promise<ForecasterBudgetLine> {
  const { rows } = await pool.query<{ version_id: string }>(
    'SELECT version_id FROM forecaster_budget_lines WHERE org_id = $1 AND id = $2',
    [orgId, lineId],
  );
  const existing = rows[0];
  if (existing === undefined) throw new ApiError(404, 'Budget line not found');

  await verifyVersionIsDraft(orgId, existing.version_id);

  const setClauses: string[] = [];
  const values: unknown[] = [orgId, lineId];
  if (input.amountCents !== undefined) {
    values.push(input.amountCents);
    setClauses.push(`amount_cents = $${String(values.length)}`);
  }
  if (input.justification !== undefined) {
    values.push(input.justification);
    setClauses.push(`justification = $${String(values.length)}`);
  }

  const row = await withTransaction(async (client) => {
    if (setClauses.length === 0) {
      const { rows: current } = await client.query<LineRow>(
        `SELECT ${LINE_COLUMNS} FROM forecaster_budget_lines WHERE org_id = $1 AND id = $2`,
        [orgId, lineId],
      );
      const r = current[0];
      if (r === undefined) throw new ApiError(404, 'Budget line not found');
      return r;
    }

    const { rows: updated, rowCount } = await client.query<LineRow>(
      `UPDATE forecaster_budget_lines SET ${setClauses.join(', ')}
        WHERE org_id = $1 AND id = $2
        RETURNING ${LINE_COLUMNS}`,
      values,
    );
    if (rowCount === 0) throw new ApiError(404, 'Budget line not found');
    const r = updated[0];
    if (r === undefined) throw new Error('UPDATE ... RETURNING produced no row');
    return r;
  });

  const accounts = await accountLookup(orgId);
  return toLine(row, accounts);
}

export async function deleteLine(orgId: string, lineId: string): Promise<void> {
  const { rows } = await pool.query<{ version_id: string }>(
    'SELECT version_id FROM forecaster_budget_lines WHERE org_id = $1 AND id = $2',
    [orgId, lineId],
  );
  const existing = rows[0];
  if (existing === undefined) throw new ApiError(404, 'Budget line not found');

  await verifyVersionIsDraft(orgId, existing.version_id);

  await withTransaction(async (client) => {
    const result = await client.query('DELETE FROM forecaster_budget_lines WHERE org_id = $1 AND id = $2', [
      orgId,
      lineId,
    ]);
    if (result.rowCount === 0) throw new ApiError(404, 'Budget line not found');
  });
}

/** For varianceService. The plan's APPROVED version's lines, or null when there is none. */
export async function approvedVersionLines(
  orgId: string,
  planId: string,
): Promise<{ versionId: string; label: string; lines: ForecasterBudgetLine[] } | null> {
  const { rows } = await pool.query<{ id: string; label: string }>(
    `SELECT id, label FROM forecaster_budget_versions
      WHERE org_id = $1 AND plan_id = $2 AND status = 'APPROVED'`,
    [orgId, planId],
  );
  const version = rows[0];
  if (version === undefined) return null;

  const { rows: lineRows } = await pool.query<LineRow>(
    `SELECT ${LINE_COLUMNS}
       FROM forecaster_budget_lines
      WHERE org_id = $1 AND version_id = $2
      ORDER BY month ASC, account_id ASC`,
    [orgId, version.id],
  );

  const accounts = await accountLookup(orgId);
  return { versionId: version.id, label: version.label, lines: lineRows.map((r) => toLine(r, accounts)) };
}
