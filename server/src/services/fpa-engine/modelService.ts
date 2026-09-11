import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import {
  canTransitionFpaModel,
  type FpaModel,
  type FpaModelDetail,
  type FpaModelStatus,
  type FpaScenario,
  type FpaScenarioKind,
} from '../../types/fpa-engine.js';

/**
 * FP&A Engine (Phase 12) — models and scenarios. A model is a named forecast
 * container; a scenario hangs off it with its own DSO/DPO/tax-rate
 * assumptions. Creating a model always creates a default 'Base' scenario in
 * the same transaction — a model with no scenario is not a reachable state.
 *
 * Nothing here posts to the general ledger, so rule 6 (posted documents are
 * immutable) does not apply: PATCH and DELETE on a model or scenario are
 * correct, not a violation. See migration 033's header for the full ruling.
 */

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface ModelRow {
  id: string;
  name: string;
  description: string | null;
  starts_on: string;
  horizon_months: number;
  actuals_through: string;
  status: FpaModelStatus;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  scenario_count: string;
}

function toModel(row: ModelRow): FpaModel {
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
    scenarioCount: Number(row.scenario_count),
  };
}

interface ScenarioRow {
  id: string;
  model_id: string;
  name: string;
  kind: FpaScenarioKind;
  is_default: boolean;
  dso_days: number;
  dpo_days: number;
  tax_rate_bps: number;
  created_at: Date;
  updated_at: Date;
}

function toScenario(row: ScenarioRow): FpaScenario {
  return {
    id: row.id,
    modelId: row.model_id,
    name: row.name,
    kind: row.kind,
    isDefault: row.is_default,
    dsoDays: row.dso_days,
    dpoDays: row.dpo_days,
    taxRateBps: row.tax_rate_bps,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const MODEL_SELECT = `
  SELECT m.id, m.name, m.description, m.starts_on, m.horizon_months, m.actuals_through,
         m.status, m.created_by, u.name AS created_by_name, m.created_at, m.updated_at,
         COALESCE(s.scenario_count, 0) AS scenario_count
    FROM fpa_models m
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN (
      SELECT org_id, model_id, COUNT(*) AS scenario_count
        FROM fpa_scenarios
       GROUP BY org_id, model_id
    ) s ON s.org_id = m.org_id AND s.model_id = m.id`;

export interface ListModelsOptions {
  page: number;
  limit: number;
  status: FpaModelStatus | null;
}

export async function listModels(
  orgId: string,
  options: ListModelsOptions,
): Promise<{ models: FpaModel[]; totalCount: number }> {
  const offset = (options.page - 1) * options.limit;

  const { rows } = await pool.query<ModelRow>(
    `${MODEL_SELECT}
    WHERE m.org_id = $1
      AND ($2::text IS NULL OR m.status = $2)
    ORDER BY m.starts_on DESC, m.id DESC
    LIMIT $3 OFFSET $4`,
    [orgId, options.status, options.limit, offset],
  );

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM fpa_models m
      WHERE m.org_id = $1
        AND ($2::text IS NULL OR m.status = $2)`,
    [orgId, options.status],
  );

  return { models: rows.map(toModel), totalCount: Number(countRows[0]?.count ?? '0') };
}

export async function getModelById(orgId: string, id: string): Promise<FpaModelDetail> {
  const { rows } = await pool.query<ModelRow>(
    `${MODEL_SELECT}
    WHERE m.org_id = $1 AND m.id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Model not found');

  const { rows: scenarioRows } = await pool.query<ScenarioRow>(
    `SELECT id, model_id, name, kind, is_default, dso_days, dpo_days, tax_rate_bps, created_at, updated_at
       FROM fpa_scenarios
      WHERE org_id = $1 AND model_id = $2
      ORDER BY is_default DESC, name ASC`,
    [orgId, id],
  );

  return { ...toModel(row), scenarios: scenarioRows.map(toScenario) };
}

export async function createModel(
  orgId: string,
  createdBy: string,
  input: {
    name: string;
    description: string | null;
    startsOn: string;
    horizonMonths: number;
    actualsThrough: string;
  },
): Promise<FpaModelDetail> {
  if (input.actualsThrough >= input.startsOn) {
    throw new ApiError(422, 'actualsThrough must be before startsOn');
  }

  try {
    const newId = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO fpa_models (org_id, name, description, starts_on, horizon_months, actuals_through, created_by)
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

      await client.query(
        `INSERT INTO fpa_scenarios (org_id, model_id, name, kind, is_default, dso_days, dpo_days, tax_rate_bps)
         VALUES ($1, $2, 'Base', 'BASE', true, 0, 0, 0)`,
        [orgId, id],
      );

      return id;
    });

    return await getModelById(orgId, newId);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A model with that name already exists');
    }
    throw err;
  }
}

// Column names come from this frozen map, never from the request — rule 4
// forbids interpolating an identifier a caller could influence. `as const`,
// matching settingsService.updateSettings's own COLUMNS map.
const MODEL_UPDATE_COLUMNS = {
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
 * `undefined`, which is exactly what a zod `.partial()` schema infers. See
 * `settingsService.UpdateSettingsInput` for the same convention.
 */
export interface UpdateModelInput {
  name?: string | undefined;
  description?: string | null | undefined;
  startsOn?: string | undefined;
  horizonMonths?: number | undefined;
  actualsThrough?: string | undefined;
  status?: FpaModelStatus | undefined;
}

export async function updateModel(orgId: string, id: string, input: UpdateModelInput): Promise<FpaModelDetail> {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query<{ starts_on: string; actuals_through: string; status: FpaModelStatus }>(
        'SELECT starts_on, actuals_through, status FROM fpa_models WHERE org_id = $1 AND id = $2 FOR UPDATE',
        [orgId, id],
      );
      const current = rows[0];
      if (current === undefined) throw new ApiError(404, 'Model not found');

      if (input.status !== undefined && !canTransitionFpaModel(current.status, input.status)) {
        throw new ApiError(409, `Cannot move a model from ${current.status} to ${input.status}`);
      }

      const nextStartsOn = input.startsOn ?? current.starts_on;
      const nextActualsThrough = input.actualsThrough ?? current.actuals_through;
      if (nextActualsThrough >= nextStartsOn) {
        throw new ApiError(422, 'actualsThrough must be before startsOn');
      }

      const setClauses: string[] = [];
      const values: unknown[] = [orgId, id];
      for (const key of Object.keys(MODEL_UPDATE_COLUMNS) as (keyof typeof MODEL_UPDATE_COLUMNS)[]) {
        const value = input[key];
        if (value === undefined) continue;
        values.push(value);
        setClauses.push(`${MODEL_UPDATE_COLUMNS[key]} = $${String(values.length)}`);
      }
      if (input.status !== undefined) {
        values.push(input.status);
        setClauses.push(`status = $${String(values.length)}`);
      }
      if (setClauses.length === 0) return;

      await client.query(
        `UPDATE fpa_models SET ${setClauses.join(', ')} WHERE org_id = $1 AND id = $2`,
        values,
      );
    });

    return await getModelById(orgId, id);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A model with that name already exists');
    }
    throw err;
  }
}

export async function deleteModel(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query('DELETE FROM fpa_models WHERE org_id = $1 AND id = $2', [orgId, id]);
    if (result.rowCount === 0) throw new ApiError(404, 'Model not found');
  });
}

export async function listScenarios(orgId: string, modelId: string): Promise<FpaScenario[]> {
  const { rows: modelRows } = await pool.query('SELECT 1 FROM fpa_models WHERE org_id = $1 AND id = $2', [
    orgId,
    modelId,
  ]);
  if (modelRows.length === 0) throw new ApiError(404, 'Model not found');

  const { rows } = await pool.query<ScenarioRow>(
    `SELECT id, model_id, name, kind, is_default, dso_days, dpo_days, tax_rate_bps, created_at, updated_at
       FROM fpa_scenarios
      WHERE org_id = $1 AND model_id = $2
      ORDER BY is_default DESC, name ASC`,
    [orgId, modelId],
  );
  return rows.map(toScenario);
}

export async function getScenarioById(orgId: string, id: string): Promise<FpaScenario> {
  const { rows } = await pool.query<ScenarioRow>(
    `SELECT id, model_id, name, kind, is_default, dso_days, dpo_days, tax_rate_bps, created_at, updated_at
       FROM fpa_scenarios
      WHERE org_id = $1 AND id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Scenario not found');
  return toScenario(row);
}

export async function createScenario(
  orgId: string,
  modelId: string,
  input: { name: string; kind: FpaScenarioKind; dsoDays: number; dpoDays: number; taxRateBps: number },
): Promise<FpaScenario> {
  const { rows: modelRows } = await pool.query('SELECT 1 FROM fpa_models WHERE org_id = $1 AND id = $2', [
    orgId,
    modelId,
  ]);
  if (modelRows.length === 0) throw new ApiError(404, 'Model not found');

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<ScenarioRow>(
        `INSERT INTO fpa_scenarios (org_id, model_id, name, kind, is_default, dso_days, dpo_days, tax_rate_bps)
         VALUES ($1, $2, $3, $4, false, $5, $6, $7)
         RETURNING id, model_id, name, kind, is_default, dso_days, dpo_days, tax_rate_bps, created_at, updated_at`,
        [orgId, modelId, input.name, input.kind, input.dsoDays, input.dpoDays, input.taxRateBps],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
      return toScenario(row);
    });
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A scenario with that name already exists on this model');
    }
    throw err;
  }
}

// Same frozen-map discipline as MODEL_UPDATE_COLUMNS above.
const SCENARIO_UPDATE_COLUMNS = {
  name: 'name',
  kind: 'kind',
  dsoDays: 'dso_days',
  dpoDays: 'dpo_days',
  taxRateBps: 'tax_rate_bps',
} as const;

export interface UpdateScenarioInput {
  name?: string | undefined;
  kind?: FpaScenarioKind | undefined;
  isDefault?: true | undefined;
  dsoDays?: number | undefined;
  dpoDays?: number | undefined;
  taxRateBps?: number | undefined;
}

export async function updateScenario(orgId: string, id: string, input: UpdateScenarioInput): Promise<FpaScenario> {
  try {
    return await withTransaction(async (client) => {
      const { rows: existing } = await client.query<{ model_id: string }>(
        'SELECT model_id FROM fpa_scenarios WHERE org_id = $1 AND id = $2 FOR UPDATE',
        [orgId, id],
      );
      const modelId = existing[0]?.model_id;
      if (modelId === undefined) throw new ApiError(404, 'Scenario not found');

      // Un-set the current default BEFORE promoting this one — the other
      // order trips ux_fpa_scenarios_one_default (migration 033).
      if (input.isDefault === true) {
        await client.query(
          'UPDATE fpa_scenarios SET is_default = false WHERE org_id = $1 AND model_id = $2 AND is_default',
          [orgId, modelId],
        );
      }

      const setClauses: string[] = [];
      const values: unknown[] = [orgId, id];
      for (const key of Object.keys(SCENARIO_UPDATE_COLUMNS) as (keyof typeof SCENARIO_UPDATE_COLUMNS)[]) {
        const value = input[key];
        if (value === undefined) continue;
        values.push(value);
        setClauses.push(`${SCENARIO_UPDATE_COLUMNS[key]} = $${String(values.length)}`);
      }
      if (input.isDefault === true) {
        setClauses.push('is_default = true');
      }

      const { rows } = await client.query<ScenarioRow>(
        `UPDATE fpa_scenarios SET ${setClauses.join(', ')}
          WHERE org_id = $1 AND id = $2
          RETURNING id, model_id, name, kind, is_default, dso_days, dpo_days, tax_rate_bps, created_at, updated_at`,
        values,
      );
      const row = rows[0];
      if (row === undefined) throw new Error('UPDATE ... RETURNING returned no row');
      return toScenario(row);
    });
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, 'A scenario with that name already exists on this model');
    }
    throw err;
  }
}

export async function deleteScenario(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ model_id: string; is_default: boolean }>(
      'SELECT model_id, is_default FROM fpa_scenarios WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Scenario not found');

    if (row.is_default) {
      throw new ApiError(409, 'The default scenario cannot be deleted');
    }

    const { rows: countRows } = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM fpa_scenarios WHERE org_id = $1 AND model_id = $2',
      [orgId, row.model_id],
    );
    if (Number(countRows[0]?.count ?? '0') <= 1) {
      throw new ApiError(409, 'A model must keep at least one scenario');
    }

    const result = await client.query('DELETE FROM fpa_scenarios WHERE org_id = $1 AND id = $2', [orgId, id]);
    if (result.rowCount === 0) throw new ApiError(404, 'Scenario not found');
  });
}
