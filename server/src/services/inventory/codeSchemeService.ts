import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import {
  exampleCode,
  parseCodePattern,
  renderCode,
  renderScopeKey,
  type CodeRenderContext,
} from '../../utils/stockCodePattern.js';
import { CODE_SCHEME_PRESETS } from '../../config/inventoryIndustryProfiles.js';
import type { StockCodeScheme } from '../../types/inventory.js';

/**
 * Inventory (Phase 28) — item-code schemes and their per-scope counters.
 *
 * The counter pattern is the standard "counter row with a lock" from
 * study/postgresql/gapless-numbering-and-counters.md: `INSERT ... ON
 * CONFLICT DO UPDATE ... RETURNING` allocates the next value atomically,
 * scoped per (scheme, rendered scope key) so different categories/years
 * never contend with each other. `nextCodeOnClient` runs entirely on the
 * caller's transaction `client` (rule 5) — a rolled-back item create rolls
 * the counter bump back with it, so numbering stays gapless.
 */

const PG_UNIQUE_VIOLATION = '23505';
const MAX_CODE_ATTEMPTS = 20;

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface CodeSchemeRow {
  id: string;
  name: string;
  pattern: string;
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const SCHEME_COLUMNS = 'id, name, pattern, is_default, is_active, created_at, updated_at';

function toScheme(row: CodeSchemeRow): StockCodeScheme {
  const rendered = exampleCode(row.pattern, 'CAT', new Date());
  return {
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    isDefault: row.is_default,
    isActive: row.is_active,
    example: rendered.ok ? rendered.value : '',
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listCodeSchemes(orgId: string, includeInactive: boolean): Promise<StockCodeScheme[]> {
  const clause = includeInactive ? '' : 'AND is_active = true';
  const { rows } = await pool.query<CodeSchemeRow>(
    `SELECT ${SCHEME_COLUMNS} FROM stock_code_schemes WHERE org_id = $1 ${clause} ORDER BY is_default DESC, name ASC`,
    [orgId],
  );
  return rows.map(toScheme);
}

export async function createCodeScheme(
  orgId: string,
  userId: string,
  input: { name: string; pattern: string; isDefault: boolean },
): Promise<StockCodeScheme> {
  const parsed = parseCodePattern(input.pattern);
  if (!parsed.ok) throw new ApiError(422, `Invalid code pattern: ${parsed.error}`);

  try {
    const { rows } = await withTransaction(async (client) => {
      if (input.isDefault) {
        await client.query('UPDATE stock_code_schemes SET is_default = false WHERE org_id = $1 AND is_default', [orgId]);
      }
      return client.query<CodeSchemeRow>(
        `INSERT INTO stock_code_schemes (org_id, name, pattern, is_default, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${SCHEME_COLUMNS}`,
        [orgId, input.name, input.pattern, input.isDefault, userId],
      );
    });
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return toScheme(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Code scheme name already exists');
    throw err;
  }
}

export async function updateCodeScheme(
  orgId: string,
  id: string,
  input: { name?: string | undefined; isDefault?: true | undefined; isActive?: boolean | undefined },
): Promise<StockCodeScheme> {
  try {
    const { rows } = await withTransaction(async (client) => {
      const { rows: existingRows } = await client.query<{ is_active: boolean; is_default: boolean }>(
        'SELECT is_active, is_default FROM stock_code_schemes WHERE id = $1 AND org_id = $2',
        [id, orgId],
      );
      const existing = existingRows[0];
      if (existing === undefined) throw new ApiError(404, 'Code scheme not found');

      const willBeActive = input.isActive ?? existing.is_active;
      if (input.isDefault === true && !willBeActive) {
        throw new ApiError(422, 'An inactive code scheme cannot be the default');
      }
      if (input.isActive === false && existing.is_default && input.isDefault !== true) {
        throw new ApiError(422, 'Choose another default before deactivating this scheme');
      }

      // Two statements, never one `SET is_default = (id = $2)`: the
      // non-deferrable one-default partial unique index (migration 065) is
      // checked row by row, so a single UPDATE that both unsets the old
      // default and sets the new one in the same statement can transiently
      // violate it depending on row processing order. Unsetting everything
      // first, then setting the target row, never can.
      if (input.isDefault === true) {
        await client.query('UPDATE stock_code_schemes SET is_default = false WHERE org_id = $1 AND is_default', [orgId]);
      }

      const assignments: string[] = [];
      const values: unknown[] = [id, orgId];
      if (input.name !== undefined) {
        values.push(input.name);
        assignments.push(`name = $${String(values.length)}`);
      }
      if (input.isDefault === true) {
        values.push(true);
        assignments.push(`is_default = $${String(values.length)}`);
      }
      if (input.isActive !== undefined) {
        values.push(input.isActive);
        assignments.push(`is_active = $${String(values.length)}`);
      }
      if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

      return client.query<CodeSchemeRow>(
        `UPDATE stock_code_schemes SET ${assignments.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING ${SCHEME_COLUMNS}`,
        values,
      );
    });
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Code scheme not found');
    return toScheme(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Code scheme name already exists');
    throw err;
  }
}

export async function previewPattern(
  orgId: string,
  input: { pattern: string; categoryId: string | null; attributes: Record<string, string | boolean> },
): Promise<{ valid: true; example: string; scopeKey: string } | { valid: false; error: string }> {
  let categoryCode = 'CAT';
  if (input.categoryId !== null) {
    const { rows } = await pool.query<{ code: string }>(
      'SELECT code FROM stock_categories WHERE id = $1 AND org_id = $2',
      [input.categoryId, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(422, 'Category does not exist in this organization');
    categoryCode = row.code;
  }

  const parsed = parseCodePattern(input.pattern);
  if (!parsed.ok) return { valid: false, error: parsed.error };

  const ctx: CodeRenderContext = { categoryCode, attributes: input.attributes, date: new Date() };
  const rendered = renderCode(parsed.segments, ctx, 1);
  if (!rendered.ok) return { valid: false, error: rendered.error };

  const scopeKeyResult = renderScopeKey(parsed.segments, ctx);
  return { valid: true, example: rendered.value, scopeKey: scopeKeyResult.ok ? scopeKeyResult.value : '' };
}

export function listPresets(): { name: string; pattern: string; description: string; example: string }[] {
  return CODE_SCHEME_PRESETS.map((preset) => {
    const rendered = exampleCode(preset.pattern, 'CAT', new Date());
    return { ...preset, example: rendered.ok ? rendered.value : '' };
  });
}

/**
 * Allocates the next code for an item, inside the caller's transaction.
 * Returns the code; throws ApiError(422, <render error>) on a render
 * failure. `stock_items` does not exist until migration 066 (Step 17) —
 * this function is written now and first exercised in Step 20.
 */
export async function nextCodeOnClient(
  client: PoolClient,
  orgId: string,
  schemeId: string,
  ctx: CodeRenderContext,
): Promise<string> {
  const { rows } = await client.query<{ pattern: string; is_active: boolean }>(
    'SELECT pattern, is_active FROM stock_code_schemes WHERE id = $1 AND org_id = $2',
    [schemeId, orgId],
  );
  const scheme = rows[0];
  if (scheme === undefined) throw new ApiError(422, 'Code scheme does not exist in this organization');
  if (!scheme.is_active) throw new ApiError(422, 'Code scheme is inactive');

  const parsed = parseCodePattern(scheme.pattern);
  if (!parsed.ok) throw new ApiError(422, parsed.error);

  const scopeKeyResult = renderScopeKey(parsed.segments, ctx);
  if (!scopeKeyResult.ok) throw new ApiError(422, scopeKeyResult.error);
  const scopeKey = scopeKeyResult.value;

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const { rows: counterRows } = await client.query<{ value: string }>(
      `INSERT INTO stock_code_counters (org_id, scheme_id, scope_key, next_value) VALUES ($1, $2, $3, 2)
       ON CONFLICT (org_id, scheme_id, scope_key) DO UPDATE SET next_value = stock_code_counters.next_value + 1
       RETURNING next_value - 1 AS value`,
      [orgId, schemeId, scopeKey],
    );
    const sequence = Number(counterRows[0]?.value);

    const rendered = renderCode(parsed.segments, ctx, sequence);
    if (!rendered.ok) throw new ApiError(422, rendered.error);

    const { rows: collisionRows } = await client.query('SELECT 1 FROM stock_items WHERE org_id = $1 AND code = $2', [
      orgId,
      rendered.value,
    ]);
    if (collisionRows.length === 0) return rendered.value;
  }

  throw new ApiError(409, 'Could not generate a free code; existing codes collide with this scheme');
}
