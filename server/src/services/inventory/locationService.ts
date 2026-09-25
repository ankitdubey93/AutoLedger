import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { STOCK_TOP_LEVEL_LOCATION_KINDS } from '../../types/inventory.js';
import type { StockLocation, StockLocationKind } from '../../types/inventory.js';

/**
 * Inventory (Phase 28) — the location hierarchy: warehouse/store/site at
 * the top, zone and bin nested inside. `code`, `kind` and `parent_id` are
 * frozen once created — the same "frozen parent means no cycle check is
 * needed" reasoning `catalogueService.ts` gives for categories.
 *
 * `LOCATION_TREE_CTE` is exported (not just used locally) because Step 23's
 * `stockQueryService.listBalances` needs the identical `locationPath` shape
 * and must not duplicate it.
 */

const PG_UNIQUE_VIOLATION = '23505';
const MAX_LOCATION_DEPTH = 4;

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function isTopLevelKind(kind: StockLocationKind): boolean {
  return (STOCK_TOP_LEVEL_LOCATION_KINDS as readonly string[]).includes(kind);
}

interface LocationRow {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  path: string;
  depth: number;
  kind: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toLocation(row: LocationRow): StockLocation {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind as StockLocationKind,
    parentId: row.parent_id,
    path: row.path,
    depth: row.depth,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Joined on CODE (not name) — "MAIN / A / A-01" — a shorter, scan-friendly path for labels and pickers. */
export const LOCATION_TREE_CTE = `
  WITH RECURSIVE tree AS (
    SELECT id, parent_id, code::text AS path, 1 AS depth
      FROM stock_locations WHERE org_id = $1 AND parent_id IS NULL
    UNION ALL
    SELECT l.id, l.parent_id, tree.path || ' / ' || l.code, tree.depth + 1
      FROM stock_locations l JOIN tree ON l.parent_id = tree.id
     WHERE l.org_id = $1
  )
`;

export async function listLocations(orgId: string, includeInactive: boolean): Promise<StockLocation[]> {
  const clause = includeInactive ? '' : 'AND l.is_active = true';
  const { rows } = await pool.query<LocationRow>(
    `${LOCATION_TREE_CTE}
     SELECT l.id, l.code, l.name, l.parent_id, tree.path, tree.depth, l.kind, l.is_active, l.created_at, l.updated_at
       FROM stock_locations l JOIN tree ON tree.id = l.id
      WHERE l.org_id = $1 ${clause}
      ORDER BY tree.path`,
    [orgId],
  );
  return rows.map(toLocation);
}

async function getLocation(orgId: string, id: string): Promise<StockLocation> {
  const { rows } = await pool.query<LocationRow>(
    `${LOCATION_TREE_CTE}
     SELECT l.id, l.code, l.name, l.parent_id, tree.path, tree.depth, l.kind, l.is_active, l.created_at, l.updated_at
       FROM stock_locations l JOIN tree ON tree.id = l.id
      WHERE l.org_id = $1 AND l.id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Location not found');
  return toLocation(row);
}

async function locationDepth(client: Pick<PoolClient, 'query'>, orgId: string, id: string): Promise<number | undefined> {
  const { rows } = await client.query<{ depth: number }>(`${LOCATION_TREE_CTE} SELECT tree.depth FROM tree WHERE tree.id = $2`, [
    orgId,
    id,
  ]);
  return rows[0]?.depth;
}

export async function createLocation(
  orgId: string,
  userId: string,
  input: { code: string; name: string; kind: StockLocationKind; parentId: string | null },
): Promise<StockLocation> {
  const topLevel = isTopLevelKind(input.kind);
  if ((input.parentId === null) !== topLevel) {
    throw new ApiError(
      422,
      'A WAREHOUSE, STORE or SITE must be top-level; a ZONE or BIN must sit inside another location',
    );
  }

  try {
    const { rows } = await withTransaction(async (client) => {
      if (input.parentId !== null) {
        const depth = await locationDepth(client, orgId, input.parentId);
        if (depth === undefined) throw new ApiError(422, 'Parent location does not exist in this organization');
        if (depth >= MAX_LOCATION_DEPTH) throw new ApiError(422, 'Locations can be nested at most 4 levels deep');
      }

      return client.query<{ id: string }>(
        `INSERT INTO stock_locations (org_id, code, name, kind, parent_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [orgId, input.code, input.name, input.kind, input.parentId, userId],
      );
    });
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return getLocation(orgId, row.id);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Location code already exists');
    throw err;
  }
}

export async function updateLocation(
  orgId: string,
  id: string,
  input: { name?: string | undefined; isActive?: boolean | undefined },
): Promise<StockLocation> {
  const COLUMNS = { name: 'name', isActive: 'is_active' } as const;
  const assignments: string[] = [];
  const values: unknown[] = [id, orgId];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
  }
  if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

  const { rows } = await pool.query<{ id: string }>(
    `UPDATE stock_locations SET ${assignments.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING id`,
    values,
  );
  if (rows[0] === undefined) throw new ApiError(404, 'Location not found');
  return getLocation(orgId, id);
}

/** For movement validation: the location row, or ApiError(422, ...) if it does not exist in this org. */
export async function getLocationOnClient(
  client: Pick<PoolClient, 'query'>,
  orgId: string,
  id: string,
): Promise<{ id: string; code: string; isActive: boolean }> {
  const { rows } = await client.query<{ id: string; code: string; is_active: boolean }>(
    'SELECT id, code, is_active FROM stock_locations WHERE id = $1 AND org_id = $2',
    [id, orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(422, 'Location does not exist in this organization');
  return { id: row.id, code: row.code, isActive: row.is_active };
}
