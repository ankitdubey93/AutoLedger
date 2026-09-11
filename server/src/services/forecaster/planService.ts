import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import * as driverService from './driverService.js';
import {
  canTransitionForecasterPlan,
  type ForecasterPlan,
  type ForecasterPlanStatus,
} from '../../types/forecaster.js';

/**
 * ForecasterPro (Phase 13) — forecast plans. A plan is a named forecast
 * container; drivers, headcount roles, forecast lines and budget versions
 * all hang off it.
 *
 * Nothing here posts to the general ledger, so rule 6 (posted documents are
 * immutable) does not apply: PATCH and DELETE on a plan are correct, not a
 * violation. See migration 035's header for the full ruling.
 */

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  starts_on: string;
  horizon_months: number;
  actuals_through: string;
  status: ForecasterPlanStatus;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

function toPlan(row: PlanRow): ForecasterPlan {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startsOn: row.starts_on,
    horizonMonths: row.horizon_months,
    actualsThrough: row.actuals_through,
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? '(unknown user)',
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const PLAN_SELECT = `
  SELECT p.id, p.name, p.description, p.starts_on, p.horizon_months, p.actuals_through,
         p.status, p.created_by, u.name AS created_by_name, p.created_at, p.updated_at
    FROM forecaster_plans p
    LEFT JOIN users u ON u.id = p.created_by`;

/**
 * `horizonMonths` month-start strings beginning at `startsOn`. Built with
 * `Date.UTC`, never `new Date(iso)` — see phase-wide decision #12.
 */
export function planMonths(startsOn: string, horizonMonths: number): string[] {
  const [yearStr, monthStr] = startsOn.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-12

  const months: string[] = [];
  for (let k = 0; k < horizonMonths; k++) {
    const d = new Date(Date.UTC(year, month - 1 + k, 1));
    months.push(d.toISOString().slice(0, 10));
  }
  return months;
}

export interface ListPlansOptions {
  page: number;
  limit: number;
  status: ForecasterPlanStatus | null;
}

export async function listPlans(
  orgId: string,
  options: ListPlansOptions,
): Promise<{ plans: ForecasterPlan[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;

  const { rows } = await pool.query<PlanRow>(
    `${PLAN_SELECT}
    WHERE p.org_id = $1
      AND ($2::text IS NULL OR p.status = $2)
    ORDER BY p.starts_on DESC, p.id DESC
    LIMIT $3 OFFSET $4`,
    [orgId, options.status, options.limit, offset],
  );

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM forecaster_plans p
      WHERE p.org_id = $1
        AND ($2::text IS NULL OR p.status = $2)`,
    [orgId, options.status],
  );

  return { plans: rows.map(toPlan), totalCount: Number(countRows[0]?.count ?? '0') };
}

export async function getPlanById(orgId: string, id: string): Promise<ForecasterPlan> {
  const { rows } = await pool.query<PlanRow>(
    `${PLAN_SELECT}
    WHERE p.org_id = $1 AND p.id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Plan not found');
  return toPlan(row);
}

export interface CreatePlanInput {
  name: string;
  description: string | null;
  startsOn: string;
  horizonMonths: number;
  actualsThrough: string;
}

export async function createPlan(
  orgId: string,
  createdBy: string,
  input: CreatePlanInput,
): Promise<ForecasterPlan> {
  if (input.actualsThrough >= input.startsOn) {
    throw new ApiError(422, 'actualsThrough must be before startsOn');
  }

  try {
    const newId = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO forecaster_plans (org_id, name, description, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          orgId,
          input.name,
          input.description,
          input.startsOn,
          input.horizonMonths,
          input.actualsThrough,
          createdBy,
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('INSERT ... RETURNING id returned no row');
      return id;
    });

    return await getPlanById(orgId, newId);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A plan with that name already exists');
    }
    throw err;
  }
}

// Column names come from this frozen map, never from the request — rule 4
// forbids interpolating an identifier a caller could influence.
const PLAN_UPDATE_COLUMNS = {
  name: 'name',
  description: 'description',
  startsOn: 'starts_on',
  horizonMonths: 'horizon_months',
  actualsThrough: 'actuals_through',
} as const;

/**
 * Every field explicitly `| undefined`, not `Partial<{...}>` — under this
 * project's `exactOptionalPropertyTypes`, `Partial` makes a property
 * omittable but does not widen its value type to accept an explicit
 * `undefined`, which is exactly what a zod `.partial()` schema infers.
 */
export interface UpdatePlanInput {
  name?: string | undefined;
  description?: string | null | undefined;
  startsOn?: string | undefined;
  horizonMonths?: number | undefined;
  actualsThrough?: string | undefined;
  status?: ForecasterPlanStatus | undefined;
}

export async function updatePlan(
  orgId: string,
  id: string,
  input: UpdatePlanInput,
): Promise<ForecasterPlan> {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query<{
        starts_on: string;
        actuals_through: string;
        status: ForecasterPlanStatus;
      }>(
        'SELECT starts_on, actuals_through, status FROM forecaster_plans WHERE org_id = $1 AND id = $2 FOR UPDATE',
        [orgId, id],
      );
      const current = rows[0];
      if (current === undefined) throw new ApiError(404, 'Plan not found');

      if (input.status !== undefined && !canTransitionForecasterPlan(current.status, input.status)) {
        throw new ApiError(409, `Cannot move a plan from ${current.status} to ${input.status}`);
      }

      const nextStartsOn = input.startsOn ?? current.starts_on;
      const nextActualsThrough = input.actualsThrough ?? current.actuals_through;
      if (nextActualsThrough >= nextStartsOn) {
        throw new ApiError(422, 'actualsThrough must be before startsOn');
      }

      const setClauses: string[] = [];
      const values: unknown[] = [orgId, id];
      for (const key of Object.keys(PLAN_UPDATE_COLUMNS) as (keyof typeof PLAN_UPDATE_COLUMNS)[]) {
        const value = input[key];
        if (value === undefined) continue;
        values.push(value);
        setClauses.push(`${PLAN_UPDATE_COLUMNS[key]} = $${String(values.length)}`);
      }
      if (input.status !== undefined) {
        values.push(input.status);
        setClauses.push(`status = $${String(values.length)}`);
      }
      if (setClauses.length === 0) return;

      await client.query(
        `UPDATE forecaster_plans SET ${setClauses.join(', ')} WHERE org_id = $1 AND id = $2`,
        values,
      );
    });

    return await getPlanById(orgId, id);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A plan with that name already exists');
    }
    throw err;
  }
}

export async function deletePlan(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query('DELETE FROM forecaster_plans WHERE org_id = $1 AND id = $2', [
      orgId,
      id,
    ]);
    if (result.rowCount === 0) throw new ApiError(404, 'Plan not found');
  });
}

/**
 * Advances the plan's window forward by one month, `horizon_months` held
 * constant — that is what makes the plan *rolling*: it always covers the
 * same number of months forward from the new `actuals_through`. Every
 * driver's values shift with it in the same transaction: the month that
 * dropped off the front is removed, and the new trailing month copies the
 * value from the month before it.
 */
export async function rollPlan(orgId: string, id: string): Promise<ForecasterPlan> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ starts_on: string; status: ForecasterPlanStatus }>(
      'SELECT starts_on, status FROM forecaster_plans WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const current = rows[0];
    if (current === undefined) throw new ApiError(404, 'Plan not found');
    if (current.status === 'ARCHIVED') {
      throw new ApiError(409, 'An archived plan cannot be rolled');
    }

    const { rows: updatedRows } = await client.query<{ starts_on: string; horizon_months: number }>(
      `UPDATE forecaster_plans
          SET starts_on = starts_on + INTERVAL '1 month',
              actuals_through = actuals_through + INTERVAL '1 month'
        WHERE org_id = $1 AND id = $2
        RETURNING starts_on::text, horizon_months`,
      [orgId, id],
    );
    const updated = updatedRows[0];
    if (updated === undefined) throw new Error('UPDATE ... RETURNING returned no row');

    const oldStartsOn = current.starts_on;
    const months = planMonths(updated.starts_on, updated.horizon_months);
    const newLastMonth = months[months.length - 1];
    if (newLastMonth === undefined) throw new Error('planMonths returned an empty array');

    await driverService.shiftDriverValuesOnClient(client, orgId, id, oldStartsOn, newLastMonth);
  });

  return await getPlanById(orgId, id);
}
