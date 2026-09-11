import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import type { ForecasterDriver, ForecasterDriverKind, ForecasterDriverValue } from '../../types/forecaster.js';

/**
 * ForecasterPro (Phase 13) — drivers and their monthly values. A driver is a
 * named quantity (a unit count, a price, or a rate) on a plan; a value hangs
 * off it per month.
 *
 * `value >= 0` for COUNT and BPS drivers is enforced here, at write time
 * (migration 036's header explains why the CHECK cannot live in the
 * schema) — this guard is what guarantees `scaleCents`, which rejects a
 * negative numerator, is never handed one by the Phase-13 forecast engine.
 */

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface DriverRow {
  id: string;
  plan_id: string;
  name: string;
  unit_label: string;
  kind: ForecasterDriverKind;
  created_at: Date;
  updated_at: Date;
}

function toDriver(row: DriverRow): ForecasterDriver {
  return {
    id: row.id,
    planId: row.plan_id,
    name: row.name,
    unitLabel: row.unit_label,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function verifyPlanBelongsToOrg(orgId: string, planId: string): Promise<void> {
  const { rows } = await pool.query('SELECT 1 FROM forecaster_plans WHERE org_id = $1 AND id = $2', [
    orgId,
    planId,
  ]);
  if (rows.length === 0) throw new ApiError(404, 'Plan not found');
}

export async function listDrivers(orgId: string, planId: string): Promise<ForecasterDriver[]> {
  await verifyPlanBelongsToOrg(orgId, planId);

  const { rows } = await pool.query<DriverRow>(
    `SELECT id, plan_id, name, unit_label, kind, created_at, updated_at
       FROM forecaster_drivers
      WHERE org_id = $1 AND plan_id = $2
      ORDER BY name ASC`,
    [orgId, planId],
  );
  return rows.map(toDriver);
}

export async function getDriverById(orgId: string, id: string): Promise<ForecasterDriver> {
  const { rows } = await pool.query<DriverRow>(
    `SELECT id, plan_id, name, unit_label, kind, created_at, updated_at
       FROM forecaster_drivers
      WHERE org_id = $1 AND id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Driver not found');
  return toDriver(row);
}

export interface CreateDriverInput {
  name: string;
  unitLabel: string;
  kind: ForecasterDriverKind;
}

export async function createDriver(
  orgId: string,
  planId: string,
  input: CreateDriverInput,
): Promise<ForecasterDriver> {
  await verifyPlanBelongsToOrg(orgId, planId);

  try {
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query<DriverRow>(
        `INSERT INTO forecaster_drivers (org_id, plan_id, name, unit_label, kind)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, plan_id, name, unit_label, kind, created_at, updated_at`,
        [orgId, planId, input.name, input.unitLabel, input.kind],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('INSERT ... RETURNING produced no row');
      return r;
    });
    return toDriver(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A driver with that name already exists on this plan');
    }
    throw err;
  }
}

const DRIVER_UPDATE_COLUMNS = {
  name: 'name',
  unitLabel: 'unit_label',
} as const;

export interface UpdateDriverInput {
  name?: string | undefined;
  unitLabel?: string | undefined;
}

export async function updateDriver(
  orgId: string,
  id: string,
  input: UpdateDriverInput,
): Promise<ForecasterDriver> {
  try {
    const row = await withTransaction(async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [orgId, id];
      for (const key of Object.keys(DRIVER_UPDATE_COLUMNS) as (keyof typeof DRIVER_UPDATE_COLUMNS)[]) {
        const value = input[key];
        if (value === undefined) continue;
        values.push(value);
        setClauses.push(`${DRIVER_UPDATE_COLUMNS[key]} = $${String(values.length)}`);
      }
      if (setClauses.length === 0) {
        const { rows } = await client.query<DriverRow>(
          `SELECT id, plan_id, name, unit_label, kind, created_at, updated_at
             FROM forecaster_drivers WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        const r = rows[0];
        if (r === undefined) throw new ApiError(404, 'Driver not found');
        return r;
      }

      const { rows, rowCount } = await client.query<DriverRow>(
        `UPDATE forecaster_drivers SET ${setClauses.join(', ')}
          WHERE org_id = $1 AND id = $2
          RETURNING id, plan_id, name, unit_label, kind, created_at, updated_at`,
        values,
      );
      if (rowCount === 0) throw new ApiError(404, 'Driver not found');
      const r = rows[0];
      if (r === undefined) throw new Error('UPDATE ... RETURNING produced no row');
      return r;
    });
    return toDriver(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A driver with that name already exists on this plan');
    }
    throw err;
  }
}

export async function deleteDriver(orgId: string, id: string): Promise<void> {
  try {
    await withTransaction(async (client) => {
      const result = await client.query('DELETE FROM forecaster_drivers WHERE org_id = $1 AND id = $2', [
        orgId,
        id,
      ]);
      if (result.rowCount === 0) throw new ApiError(404, 'Driver not found');
    });
  } catch (err) {
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
      throw new ApiError(409, 'This driver is used by a forecast line and cannot be deleted');
    }
    throw err;
  }
}

interface DriverValueRow {
  driver_id: string;
  month: string;
  value: string;
}

export async function listDriverValues(orgId: string, driverId: string): Promise<ForecasterDriverValue[]> {
  await getDriverById(orgId, driverId);

  const { rows } = await pool.query<DriverValueRow>(
    `SELECT driver_id, month::text AS month, value::text AS value
       FROM forecaster_driver_values
      WHERE org_id = $1 AND driver_id = $2
      ORDER BY month ASC`,
    [orgId, driverId],
  );
  return rows.map((row) => ({ driverId: row.driver_id, month: row.month, value: Number(row.value) }));
}

export async function setDriverValues(
  orgId: string,
  driverId: string,
  values: readonly { month: string; value: number }[],
): Promise<ForecasterDriverValue[]> {
  const driver = await getDriverById(orgId, driverId);

  if (driver.kind === 'COUNT' || driver.kind === 'BPS') {
    if (values.some((v) => v.value < 0)) {
      throw new ApiError(422, 'A COUNT or BPS driver value cannot be negative');
    }
  }

  await withTransaction(async (client) => {
    for (const v of values) {
      await client.query(
        `INSERT INTO forecaster_driver_values (org_id, driver_id, month, value)
         VALUES ($1, $2, $3::date, $4)
         ON CONFLICT (org_id, driver_id, month) DO UPDATE SET value = EXCLUDED.value`,
        [orgId, driverId, v.month, v.value],
      );
    }
  });

  return listDriverValues(orgId, driverId);
}

/**
 * Shifts the driver-value window forward by one month for every driver on
 * the plan: the month that dropped off the front is removed, and the new
 * trailing month copies the value from the month before it. Runs on the
 * caller's transaction client (rule 5) — used by planService.rollPlan.
 */
export async function shiftDriverValuesOnClient(
  client: PoolClient,
  orgId: string,
  planId: string,
  oldStartsOn: string,
  newLastMonth: string,
): Promise<void> {
  await client.query(
    `DELETE FROM forecaster_driver_values
      WHERE org_id = $1 AND month = $2
        AND driver_id IN (SELECT id FROM forecaster_drivers WHERE org_id = $1 AND plan_id = $3)`,
    [orgId, oldStartsOn, planId],
  );

  await client.query(
    `INSERT INTO forecaster_driver_values (org_id, driver_id, month, value)
     SELECT v.org_id, v.driver_id, $2::date, v.value
       FROM forecaster_driver_values v
      WHERE v.org_id = $1
        AND v.month = ($2::date - INTERVAL '1 month')::date
        AND v.driver_id IN (SELECT id FROM forecaster_drivers WHERE org_id = $1 AND plan_id = $3)
     ON CONFLICT (org_id, driver_id, month) DO NOTHING`,
    [orgId, newLastMonth, planId],
  );
}

interface PlanDriverValueRow {
  driver_id: string;
  kind: ForecasterDriverKind;
  month: string;
  value: string;
}

/** Every driver value on a plan, in one query. Used by the Slice D engine. */
export async function listPlanDriverValues(
  orgId: string,
  planId: string,
): Promise<{ driverId: string; kind: ForecasterDriverKind; month: string; value: number }[]> {
  const { rows } = await pool.query<PlanDriverValueRow>(
    `SELECT v.driver_id, d.kind, v.month::text AS month, v.value::text AS value
       FROM forecaster_driver_values v
       JOIN forecaster_drivers d ON d.org_id = v.org_id AND d.id = v.driver_id
      WHERE d.org_id = $1 AND d.plan_id = $2`,
    [orgId, planId],
  );
  return rows.map((row) => ({
    driverId: row.driver_id,
    kind: row.kind,
    month: row.month,
    value: Number(row.value),
  }));
}
