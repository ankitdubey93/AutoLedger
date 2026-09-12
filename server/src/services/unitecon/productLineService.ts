import { pool } from '../../db/connect.js';
import * as accountService from '../ledger-core/accountService.js';
import { ApiError } from '../../utils/apiError.js';
import type { UniteconProductLine } from '../../types/unitecon.js';

/**
 * UnitEcon (Phase 14) — the PVM product dimension. A product line is an
 * opt-in registration of one postable Revenue account as a PVM dimension.
 *
 * Nothing here posts to the general ledger, so rule 6 (posted documents are
 * immutable) does not apply: PATCH and DELETE are correct, not a violation
 * — the identical ruling migration 041's header records.
 *
 * Account validity comes from `accountService.getAccountById` only, never a
 * direct `SELECT ... FROM accounts` — `unitecon_product_lines` carries no FK
 * to `accounts` (rule 16 wins over rule 8, migration 041's header).
 */

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

function pgConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) return undefined;
  return typeof err.constraint === 'string' ? err.constraint : undefined;
}

interface ProductLineRow {
  id: string;
  revenue_account_id: string;
  name: string;
  unit_label: string;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Column whitelist for PATCH's SET clause — never build SQL from a request
 *  body's own keys (guardrails rule 4). */
const UPDATABLE_COLUMNS: Record<'name' | 'unitLabel' | 'isActive', string> = {
  name: 'name',
  unitLabel: 'unit_label',
  isActive: 'is_active',
};

async function toProductLine(
  row: ProductLineRow,
  orgId: string,
  accountCache: Map<string, { code: string; name: string }>,
): Promise<UniteconProductLine> {
  let account = accountCache.get(row.revenue_account_id);
  if (account === undefined) {
    try {
      const fetched = await accountService.getAccountById(orgId, row.revenue_account_id);
      account = { code: fetched.code, name: fetched.name };
    } catch {
      // The account was deleted or deactivated out from under this product
      // line. This is the only place that 404 is swallowed — a list must
      // not fail because one stale reference exists.
      account = { code: '(unknown)', name: '(unknown account)' };
    }
    accountCache.set(row.revenue_account_id, account);
  }

  return {
    id: row.id,
    revenueAccountId: row.revenue_account_id,
    revenueAccountCode: account.code,
    revenueAccountName: account.name,
    name: row.name,
    unitLabel: row.unit_label,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listProductLines(
  orgId: string,
  options: { includeInactive: boolean },
): Promise<UniteconProductLine[]> {
  const { rows } = await pool.query<ProductLineRow>(
    `SELECT id, revenue_account_id, name, unit_label, is_active, created_by, created_at, updated_at
       FROM unitecon_product_lines
      WHERE org_id = $1
        AND ($2::boolean OR is_active = true)
      ORDER BY name ASC`,
    [orgId, options.includeInactive],
  );

  const accountCache = new Map<string, { code: string; name: string }>();
  const lines: UniteconProductLine[] = [];
  for (const row of rows) {
    lines.push(await toProductLine(row, orgId, accountCache));
  }
  return lines;
}

export async function getProductLineById(orgId: string, id: string): Promise<UniteconProductLine> {
  const { rows } = await pool.query<ProductLineRow>(
    `SELECT id, revenue_account_id, name, unit_label, is_active, created_by, created_at, updated_at
       FROM unitecon_product_lines
      WHERE org_id = $1 AND id = $2`,
    [orgId, id],
  );

  const row = rows[0];
  // 404, never 403: a 403 would confirm the id exists in some other org.
  if (row === undefined) throw new ApiError(404, 'Product line not found');

  return toProductLine(row, orgId, new Map());
}

export interface CreateProductLineInput {
  revenueAccountId: string;
  name: string;
  unitLabel: string;
}

export async function createProductLine(
  orgId: string,
  createdBy: string,
  input: CreateProductLineInput,
): Promise<UniteconProductLine> {
  const account = await accountService.getAccountById(orgId, input.revenueAccountId);
  if (account.type !== 'Revenue') {
    throw new ApiError(422, 'A product line must map to a Revenue account');
  }
  if (!account.isPostable) {
    throw new ApiError(422, 'A product line must map to a postable account, not a header account');
  }

  try {
    const { rows } = await pool.query<ProductLineRow>(
      `INSERT INTO unitecon_product_lines (org_id, revenue_account_id, name, unit_label, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, revenue_account_id, name, unit_label, is_active, created_by, created_at, updated_at`,
      [orgId, input.revenueAccountId, input.name, input.unitLabel, createdBy],
    );

    const row = rows[0];
    if (row === undefined) throw new Error('createProductLine: insert returned no row');

    return toProductLine(row, orgId, new Map([[input.revenueAccountId, { code: account.code, name: account.name }]]));
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      const constraint = pgConstraint(err);
      if (constraint === 'ux_unitecon_product_lines_account') {
        throw new ApiError(409, 'This revenue account already has a product line');
      }
      if (constraint === 'ux_unitecon_product_lines_name') {
        throw new ApiError(409, 'A product line with this name already exists');
      }
    }
    throw err;
  }
}

export interface UpdateProductLineInput {
  name?: string | undefined;
  unitLabel?: string | undefined;
  isActive?: boolean | undefined;
}

export async function updateProductLine(
  orgId: string,
  id: string,
  input: UpdateProductLineInput,
): Promise<UniteconProductLine> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const key of Object.keys(input) as (keyof UpdateProductLineInput)[]) {
    const value = input[key];
    if (value === undefined) continue;
    const column = UPDATABLE_COLUMNS[key];
    values.push(value);
    setClauses.push(`${column} = $${String(values.length)}`);
  }

  if (setClauses.length === 0) {
    // Nothing to change; still confirm the row exists and belongs to this org.
    return getProductLineById(orgId, id);
  }

  values.push(orgId, id);
  const orgParam = values.length - 1;
  const idParam = values.length;

  try {
    const { rows } = await pool.query<ProductLineRow>(
      `UPDATE unitecon_product_lines
          SET ${setClauses.join(', ')}
        WHERE org_id = $${String(orgParam)} AND id = $${String(idParam)}
        RETURNING id, revenue_account_id, name, unit_label, is_active, created_by, created_at, updated_at`,
      values,
    );

    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Product line not found');

    return toProductLine(row, orgId, new Map());
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'ux_unitecon_product_lines_name') {
      throw new ApiError(409, 'A product line with this name already exists');
    }
    throw err;
  }
}

export async function deleteProductLine(orgId: string, id: string): Promise<void> {
  const { rowCount } = await pool.query('DELETE FROM unitecon_product_lines WHERE org_id = $1 AND id = $2', [
    orgId,
    id,
  ]);

  if (rowCount === 0) throw new ApiError(404, 'Product line not found');
}
