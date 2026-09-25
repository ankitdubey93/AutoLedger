import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import type {
  StockAttributeDefinition,
  StockAttributeScope,
  StockAttributeType,
  StockCategory,
  StockItemType,
  StockTrackingMode,
  StockUom,
} from '../../types/inventory.js';

/**
 * Inventory (Phase 28) — the org-owned catalogue: units of measure,
 * categories (nested up to 3 levels) and their custom-field definitions.
 *
 * RULINGS, written here once:
 *  - Categories are frozen once created: `code`, `parent_id`, `item_type`
 *    and `default_tracking` never change. Because a category can never be
 *    re-parented, a parent cycle is structurally impossible — there is no
 *    cycle check anywhere in this file, deliberately.
 *  - Custom fields are NOT inherited by child categories. A subcategory's
 *    attribute list is exactly what was defined on it, never its parent's.
 *  - `code`/`decimal_places` on a UoM and `key`/`applies_to`/`data_type` on
 *    an attribute definition are frozen the same way.
 *
 * Every function takes `orgId` first and every statement carries an
 * `org_id` predicate (guardrails rule 1), including the recursive CTE's
 * non-recursive AND recursive members.
 */

const PG_UNIQUE_VIOLATION = '23505';
const MAX_CATEGORY_DEPTH = 3;

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

type Queryable = Pick<PoolClient, 'query'>;

// ------------------------------------------------------------- UoMs

interface UomRow {
  id: string;
  code: string;
  name: string;
  decimal_places: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const UOM_COLUMNS = 'id, code, name, decimal_places, is_active, created_at, updated_at';

function toUom(row: UomRow): StockUom {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    decimalPlaces: row.decimal_places,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listUoms(orgId: string, includeInactive: boolean): Promise<StockUom[]> {
  const clause = includeInactive ? '' : 'AND is_active = true';
  const { rows } = await pool.query<UomRow>(
    `SELECT ${UOM_COLUMNS} FROM stock_uoms WHERE org_id = $1 ${clause} ORDER BY code ASC`,
    [orgId],
  );
  return rows.map(toUom);
}

export async function createUom(
  orgId: string,
  userId: string,
  input: { code: string; name: string; decimalPlaces: number },
): Promise<StockUom> {
  try {
    const { rows } = await pool.query<UomRow>(
      `INSERT INTO stock_uoms (org_id, code, name, decimal_places, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${UOM_COLUMNS}`,
      [orgId, input.code, input.name, input.decimalPlaces, userId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return toUom(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Unit of measure code already exists');
    throw err;
  }
}

export async function updateUom(
  orgId: string,
  id: string,
  input: { name?: string | undefined; isActive?: boolean | undefined },
): Promise<StockUom> {
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

  const { rows } = await pool.query<UomRow>(
    `UPDATE stock_uoms SET ${assignments.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING ${UOM_COLUMNS}`,
    values,
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Unit of measure not found');
  return toUom(row);
}

// ------------------------------------------------------------- Categories

interface CategoryRow {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  path: string;
  depth: number;
  item_type: string;
  default_tracking: string;
  default_uom_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toCategory(row: CategoryRow): StockCategory {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    parentId: row.parent_id,
    path: row.path,
    depth: row.depth,
    itemType: row.item_type as StockItemType,
    defaultTracking: row.default_tracking as StockTrackingMode,
    defaultUomId: row.default_uom_id,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const CATEGORY_TREE_CTE = `
  WITH RECURSIVE tree AS (
    SELECT id, parent_id, code, name::text AS path, 1 AS depth
      FROM stock_categories WHERE org_id = $1 AND parent_id IS NULL
    UNION ALL
    SELECT c.id, c.parent_id, c.code, tree.path || ' / ' || c.name, tree.depth + 1
      FROM stock_categories c JOIN tree ON c.parent_id = tree.id
     WHERE c.org_id = $1
  )
`;

export async function listCategories(orgId: string, includeInactive: boolean): Promise<StockCategory[]> {
  const clause = includeInactive ? '' : 'AND c.is_active = true';
  const { rows } = await pool.query<CategoryRow>(
    `${CATEGORY_TREE_CTE}
     SELECT c.id, c.code, c.name, c.parent_id, tree.path, tree.depth, c.item_type, c.default_tracking,
            c.default_uom_id, c.is_active, c.created_at, c.updated_at
       FROM stock_categories c JOIN tree ON tree.id = c.id
      WHERE c.org_id = $1 ${clause}
      ORDER BY tree.path`,
    [orgId],
  );
  return rows.map(toCategory);
}

export async function getCategory(
  orgId: string,
  id: string,
): Promise<{ category: StockCategory; attributes: StockAttributeDefinition[] }> {
  const { rows } = await pool.query<CategoryRow>(
    `${CATEGORY_TREE_CTE}
     SELECT c.id, c.code, c.name, c.parent_id, tree.path, tree.depth, c.item_type, c.default_tracking,
            c.default_uom_id, c.is_active, c.created_at, c.updated_at
       FROM stock_categories c JOIN tree ON tree.id = c.id
      WHERE c.org_id = $1 AND c.id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Category not found');

  const { rows: attrRows } = await pool.query<AttributeRow>(
    `SELECT ${ATTRIBUTE_COLUMNS} FROM stock_attribute_definitions WHERE org_id = $1 AND category_id = $2
      ORDER BY applies_to, sort_order, key`,
    [orgId, id],
  );

  return { category: toCategory(row), attributes: attrRows.map(toAttributeDefinition) };
}

/** Depth of an existing category, or undefined if it does not exist in this org. */
async function categoryDepth(client: Queryable, orgId: string, id: string): Promise<number | undefined> {
  const { rows } = await client.query<{ depth: number }>(
    `${CATEGORY_TREE_CTE}
     SELECT tree.depth FROM tree WHERE tree.id = $2`,
    [orgId, id],
  );
  return rows[0]?.depth;
}

async function assertUomExists(client: Queryable, orgId: string, uomId: string): Promise<void> {
  const { rows } = await client.query('SELECT 1 FROM stock_uoms WHERE id = $1 AND org_id = $2', [uomId, orgId]);
  if (rows.length === 0) throw new ApiError(422, 'Default unit of measure does not exist in this organization');
}

export async function createCategory(
  orgId: string,
  userId: string,
  input: {
    code: string;
    name: string;
    itemType: StockItemType;
    defaultTracking: StockTrackingMode;
    defaultUomId: string | null;
    parentId: string | null;
  },
): Promise<StockCategory> {
  try {
    const { rows } = await withTransaction(async (client) => {
      if (input.parentId !== null) {
        const depth = await categoryDepth(client, orgId, input.parentId);
        if (depth === undefined) throw new ApiError(422, 'Parent category does not exist in this organization');
        if (depth >= MAX_CATEGORY_DEPTH) throw new ApiError(422, 'Categories can be nested at most 3 levels deep');
      }
      if (input.defaultUomId !== null) await assertUomExists(client, orgId, input.defaultUomId);

      return client.query<{ id: string }>(
        `INSERT INTO stock_categories (org_id, code, name, item_type, default_tracking, default_uom_id, parent_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [orgId, input.code, input.name, input.itemType, input.defaultTracking, input.defaultUomId, input.parentId, userId],
      );
    });
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    const { category } = await getCategory(orgId, row.id);
    return category;
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Category code already exists');
    throw err;
  }
}

export async function updateCategory(
  orgId: string,
  id: string,
  input: { name?: string | undefined; defaultUomId?: string | null | undefined; isActive?: boolean | undefined },
): Promise<StockCategory> {
  const COLUMNS = { name: 'name', defaultUomId: 'default_uom_id', isActive: 'is_active' } as const;

  await withTransaction(async (client) => {
    if (input.defaultUomId !== undefined && input.defaultUomId !== null) {
      await assertUomExists(client, orgId, input.defaultUomId);
    }

    const assignments: string[] = [];
    const values: unknown[] = [id, orgId];
    for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
      const value = input[key];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
    }
    if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

    const { rows } = await client.query<{ id: string }>(
      `UPDATE stock_categories SET ${assignments.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING id`,
      values,
    );
    if (rows[0] === undefined) throw new ApiError(404, 'Category not found');
  });

  const { category } = await getCategory(orgId, id);
  return category;
}

// ------------------------------------------------------------- Attribute definitions

interface AttributeRow {
  id: string;
  category_id: string;
  applies_to: string;
  key: string;
  label: string;
  data_type: string;
  options: string[] | null;
  decimal_places: number | null;
  is_required: boolean;
  sort_order: number;
  is_active: boolean;
}

const ATTRIBUTE_COLUMNS =
  'id, category_id, applies_to, key, label, data_type, options, decimal_places, is_required, sort_order, is_active';

function toAttributeDefinition(row: AttributeRow): StockAttributeDefinition {
  return {
    id: row.id,
    categoryId: row.category_id,
    appliesTo: row.applies_to as StockAttributeScope,
    key: row.key,
    label: row.label,
    dataType: row.data_type as StockAttributeType,
    options: row.options,
    decimalPlaces: row.decimal_places,
    isRequired: row.is_required,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

/** Active definitions for one category and scope, ORDER BY sort_order, key. Runs on the given queryable. */
export async function getActiveDefinitions(
  q: Queryable,
  orgId: string,
  categoryId: string,
  scope: StockAttributeScope,
): Promise<StockAttributeDefinition[]> {
  const { rows } = await q.query<AttributeRow>(
    `SELECT ${ATTRIBUTE_COLUMNS} FROM stock_attribute_definitions
      WHERE org_id = $1 AND category_id = $2 AND applies_to = $3 AND is_active = true
      ORDER BY sort_order ASC, key ASC`,
    [orgId, categoryId, scope],
  );
  return rows.map(toAttributeDefinition);
}

export async function createAttribute(
  orgId: string,
  userId: string,
  categoryId: string,
  input: {
    key: string;
    label: string;
    appliesTo: StockAttributeScope;
    dataType: StockAttributeType;
    options: string[] | null;
    decimalPlaces: number | null;
    isRequired: boolean;
    sortOrder: number;
  },
): Promise<StockAttributeDefinition> {
  try {
    const optionsJson = input.options === null ? null : JSON.stringify(input.options);
    const { rows } = await pool.query<AttributeRow>(
      `INSERT INTO stock_attribute_definitions
         (org_id, category_id, applies_to, key, label, data_type, options, decimal_places, is_required, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
       RETURNING ${ATTRIBUTE_COLUMNS}`,
      [
        orgId,
        categoryId,
        input.appliesTo,
        input.key,
        input.label,
        input.dataType,
        optionsJson,
        input.decimalPlaces,
        input.isRequired,
        input.sortOrder,
        userId,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return toAttributeDefinition(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Attribute key already exists on this category');
    throw err;
  }
}

export async function updateAttribute(
  orgId: string,
  categoryId: string,
  attributeId: string,
  input: {
    label?: string | undefined;
    options?: string[] | undefined;
    isRequired?: boolean | undefined;
    sortOrder?: number | undefined;
    isActive?: boolean | undefined;
  },
): Promise<StockAttributeDefinition> {
  const { rows: existingRows } = await pool.query<{ data_type: string }>(
    'SELECT data_type FROM stock_attribute_definitions WHERE id = $1 AND category_id = $2 AND org_id = $3',
    [attributeId, categoryId, orgId],
  );
  const existing = existingRows[0];
  if (existing === undefined) throw new ApiError(404, 'Attribute not found');
  if (input.options !== undefined && existing.data_type !== 'SELECT') {
    throw new ApiError(422, 'Only SELECT attributes have options');
  }

  const assignments: string[] = [];
  const values: unknown[] = [attributeId, categoryId, orgId];

  if (input.label !== undefined) {
    values.push(input.label);
    assignments.push(`label = $${String(values.length)}`);
  }
  if (input.options !== undefined) {
    values.push(JSON.stringify(input.options));
    assignments.push(`options = $${String(values.length)}::jsonb`);
  }
  if (input.isRequired !== undefined) {
    values.push(input.isRequired);
    assignments.push(`is_required = $${String(values.length)}`);
  }
  if (input.sortOrder !== undefined) {
    values.push(input.sortOrder);
    assignments.push(`sort_order = $${String(values.length)}`);
  }
  if (input.isActive !== undefined) {
    values.push(input.isActive);
    assignments.push(`is_active = $${String(values.length)}`);
  }
  if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

  const { rows } = await pool.query<AttributeRow>(
    `UPDATE stock_attribute_definitions SET ${assignments.join(', ')}
      WHERE id = $1 AND category_id = $2 AND org_id = $3
      RETURNING ${ATTRIBUTE_COLUMNS}`,
    values,
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Attribute not found');
  return toAttributeDefinition(row);
}
