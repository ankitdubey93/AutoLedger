import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import * as accountService from '../ledger-core/accountService.js';
import type { ForecasterHeadcountRole } from '../../types/forecaster.js';

/**
 * ForecasterPro (Phase 13) — planned headcount roles. This file contains
 * ZERO queries against `accounts` or any other LedgerCore table — every
 * account fact it needs comes from `accountService`'s exported functions
 * (guardrails rule 16). `forecaster_headcount_roles.account_id` carries no
 * `REFERENCES` (migration 037's ruling); validity is enforced here instead,
 * via `accountService.getAccountById`'s own cross-tenant 404.
 */

interface RoleRow {
  id: string;
  plan_id: string;
  title: string;
  department: string | null;
  account_id: string;
  starts_on: string;
  ends_on: string | null;
  fte_count: number;
  annual_salary_cents: string;
  loading_bps: number;
  created_at: Date;
  updated_at: Date;
}

async function verifyPlanBelongsToOrg(orgId: string, planId: string): Promise<void> {
  const { rows } = await pool.query('SELECT 1 FROM forecaster_plans WHERE org_id = $1 AND id = $2', [
    orgId,
    planId,
  ]);
  if (rows.length === 0) throw new ApiError(404, 'Plan not found');
}

export interface CreateHeadcountRoleInput {
  title: string;
  department: string | null;
  accountId: string;
  startsOn: string;
  endsOn: string | null;
  fteCount: number;
  annualSalaryCents: number;
  loadingBps: number;
}

export interface UpdateHeadcountRoleInput {
  title?: string | undefined;
  department?: string | null | undefined;
  accountId?: string | undefined;
  startsOn?: string | undefined;
  endsOn?: string | null | undefined;
  fteCount?: number | undefined;
  annualSalaryCents?: number | undefined;
  loadingBps?: number | undefined;
}

async function validateAccount(orgId: string, accountId: string): Promise<void> {
  // getAccountById's own 404 propagates for a cross-tenant or unknown
  // accountId — this is what makes an invalid accountId a 404 rather than a
  // silently stored orphan.
  const account = await accountService.getAccountById(orgId, accountId);

  if (!account.isPostable || !account.isActive) {
    throw new ApiError(422, 'A headcount role must map to a postable, active account');
  }
  if (account.type !== 'Expense') {
    throw new ApiError(422, 'A headcount role must map to an Expense account');
  }
}

async function accountLookup(orgId: string): Promise<Map<string, { code: string; name: string }>> {
  const accounts = await accountService.listAccounts(orgId, { includeInactive: true });
  return new Map(accounts.map((a) => [a.id, { code: a.code, name: a.name }]));
}

function toRole(row: RoleRow, accounts: Map<string, { code: string; name: string }>): ForecasterHeadcountRole {
  const account = accounts.get(row.account_id);
  return {
    id: row.id,
    planId: row.plan_id,
    title: row.title,
    department: row.department,
    accountId: row.account_id,
    accountCode: account?.code ?? '',
    accountName: account?.name ?? '(unknown account)',
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    fteCount: row.fte_count,
    annualSalaryCents: Number(row.annual_salary_cents),
    loadingBps: row.loading_bps,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listRoles(orgId: string, planId: string): Promise<ForecasterHeadcountRole[]> {
  await verifyPlanBelongsToOrg(orgId, planId);

  const { rows } = await pool.query<RoleRow>(
    `SELECT id, plan_id, title, department, account_id, starts_on::text AS starts_on,
            ends_on::text AS ends_on, fte_count, annual_salary_cents::text AS annual_salary_cents,
            loading_bps, created_at, updated_at
       FROM forecaster_headcount_roles
      WHERE org_id = $1 AND plan_id = $2
      ORDER BY starts_on ASC, title ASC`,
    [orgId, planId],
  );

  const accounts = await accountLookup(orgId);
  return rows.map((row) => toRole(row, accounts));
}

export async function createRole(
  orgId: string,
  planId: string,
  input: CreateHeadcountRoleInput,
): Promise<ForecasterHeadcountRole> {
  await verifyPlanBelongsToOrg(orgId, planId);
  await validateAccount(orgId, input.accountId);

  if (input.endsOn !== null && input.endsOn < input.startsOn) {
    throw new ApiError(422, 'endsOn must not be before startsOn');
  }

  const row = await withTransaction(async (client) => {
    const { rows } = await client.query<RoleRow>(
      `INSERT INTO forecaster_headcount_roles
         (org_id, plan_id, title, department, account_id, starts_on, ends_on,
          fte_count, annual_salary_cents, loading_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, plan_id, title, department, account_id, starts_on::text AS starts_on,
                 ends_on::text AS ends_on, fte_count, annual_salary_cents::text AS annual_salary_cents,
                 loading_bps, created_at, updated_at`,
      [
        orgId,
        planId,
        input.title,
        input.department,
        input.accountId,
        input.startsOn,
        input.endsOn,
        input.fteCount,
        input.annualSalaryCents,
        input.loadingBps,
      ],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return r;
  });

  const accounts = await accountLookup(orgId);
  return toRole(row, accounts);
}

const ROLE_UPDATE_COLUMNS = {
  title: 'title',
  department: 'department',
  accountId: 'account_id',
  startsOn: 'starts_on',
  endsOn: 'ends_on',
  fteCount: 'fte_count',
  annualSalaryCents: 'annual_salary_cents',
  loadingBps: 'loading_bps',
} as const;

export async function updateRole(
  orgId: string,
  id: string,
  input: UpdateHeadcountRoleInput,
): Promise<ForecasterHeadcountRole> {
  if (input.accountId !== undefined) {
    await validateAccount(orgId, input.accountId);
  }

  const row = await withTransaction(async (client) => {
    const { rows: currentRows } = await client.query<{ starts_on: string; ends_on: string | null }>(
      'SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM forecaster_headcount_roles WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const current = currentRows[0];
    if (current === undefined) throw new ApiError(404, 'Headcount role not found');

    const nextStartsOn = input.startsOn ?? current.starts_on;
    const nextEndsOn = input.endsOn === undefined ? current.ends_on : input.endsOn;
    if (nextEndsOn !== null && nextEndsOn < nextStartsOn) {
      throw new ApiError(422, 'endsOn must not be before startsOn');
    }

    const setClauses: string[] = [];
    const values: unknown[] = [orgId, id];
    for (const key of Object.keys(ROLE_UPDATE_COLUMNS) as (keyof typeof ROLE_UPDATE_COLUMNS)[]) {
      const value = input[key];
      if (value === undefined) continue;
      values.push(value);
      setClauses.push(`${ROLE_UPDATE_COLUMNS[key]} = $${String(values.length)}`);
    }

    if (setClauses.length === 0) {
      const { rows } = await client.query<RoleRow>(
        `SELECT id, plan_id, title, department, account_id, starts_on::text AS starts_on,
                ends_on::text AS ends_on, fte_count, annual_salary_cents::text AS annual_salary_cents,
                loading_bps, created_at, updated_at
           FROM forecaster_headcount_roles WHERE org_id = $1 AND id = $2`,
        [orgId, id],
      );
      const r = rows[0];
      if (r === undefined) throw new ApiError(404, 'Headcount role not found');
      return r;
    }

    const { rows, rowCount } = await client.query<RoleRow>(
      `UPDATE forecaster_headcount_roles SET ${setClauses.join(', ')}
        WHERE org_id = $1 AND id = $2
        RETURNING id, plan_id, title, department, account_id, starts_on::text AS starts_on,
                  ends_on::text AS ends_on, fte_count, annual_salary_cents::text AS annual_salary_cents,
                  loading_bps, created_at, updated_at`,
      values,
    );
    if (rowCount === 0) throw new ApiError(404, 'Headcount role not found');
    const r = rows[0];
    if (r === undefined) throw new Error('UPDATE ... RETURNING produced no row');
    return r;
  });

  const accounts = await accountLookup(orgId);
  return toRole(row, accounts);
}

export async function deleteRole(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query(
      'DELETE FROM forecaster_headcount_roles WHERE org_id = $1 AND id = $2',
      [orgId, id],
    );
    if (result.rowCount === 0) throw new ApiError(404, 'Headcount role not found');
  });
}
