import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import type { Item, ItemKind } from '../../types/ledger-core.js';

/**
 * LedgerCore items — a catalogue of products/services an invoice or bill line
 * can be picked from (Phase 24). This is a CATALOGUE, not inventory: there is
 * no on-hand quantity, no stock movement, no COGS posting and no inventory
 * valuation.
 *
 * Picking an item on a line COPIES its defaults into that line; the line
 * never reads through to the item afterward (see invoice_lines.item_id /
 * bill_lines.item_id in migration 060). `code` and `kind` are frozen once
 * created, matching accounts refusing `code`/`type` on a live account.
 *
 * Every function takes `orgId` first and every statement carries an `org_id`
 * predicate (guardrails rule 1). There is no delete route: an item is
 * retired with `isActive: false`, matching `accounts` and `customers`.
 */

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

const ITEM_COLUMNS = `id, code, name, description, kind, sale_price_cents, purchase_price_cents,
                       revenue_account_id, expense_account_id, sale_tax_rate_bp, purchase_tax_rate_bp,
                       is_active, created_at, updated_at`;

interface ItemRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: string;
  sale_price_cents: string | null;
  purchase_price_cents: string | null;
  revenue_account_id: string | null;
  expense_account_id: string | null;
  sale_tax_rate_bp: number;
  purchase_tax_rate_bp: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function isItemKind(value: string): value is ItemKind {
  return value === 'SERVICE' || value === 'GOODS';
}

function toItem(row: ItemRow): Item {
  if (!isItemKind(row.kind)) throw new Error(`Unknown item kind "${row.kind}" on item ${row.id}`);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    salePriceCents: row.sale_price_cents === null ? null : Number(row.sale_price_cents),
    purchasePriceCents: row.purchase_price_cents === null ? null : Number(row.purchase_price_cents),
    revenueAccountId: row.revenue_account_id,
    expenseAccountId: row.expense_account_id,
    saleTaxRateBp: row.sale_tax_rate_bp,
    purchaseTaxRateBp: row.purchase_tax_rate_bp,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface CreateItemInput {
  code: string;
  name: string;
  description: string | null;
  kind: ItemKind;
  salePriceCents: number | null;
  purchasePriceCents: number | null;
  revenueAccountId: string | null;
  expenseAccountId: string | null;
  saleTaxRateBp: number;
  purchaseTaxRateBp: number;
}

export interface UpdateItemInput {
  name?: string | undefined;
  description?: string | null | undefined;
  salePriceCents?: number | null | undefined;
  purchasePriceCents?: number | null | undefined;
  revenueAccountId?: string | null | undefined;
  expenseAccountId?: string | null | undefined;
  saleTaxRateBp?: number | undefined;
  purchaseTaxRateBp?: number | undefined;
  isActive?: boolean | undefined;
}

export async function listItems(
  orgId: string,
  options: { q: string | null; kind: ItemKind | null; includeInactive: boolean },
): Promise<Item[]> {
  const clauses = ['org_id = $1'];
  const values: unknown[] = [orgId];

  if (!options.includeInactive) clauses.push('is_active = true');
  if (options.kind !== null) {
    values.push(options.kind);
    clauses.push(`kind = $${String(values.length)}`);
  }
  if (options.q !== null) {
    values.push(options.q);
    const p = `$${String(values.length)}`;
    clauses.push(`(code ILIKE '%' || ${p} || '%' OR name ILIKE '%' || ${p} || '%')`);
  }

  const { rows } = await pool.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE ${clauses.join(' AND ')} ORDER BY code ASC, id ASC`,
    values,
  );
  return rows.map(toItem);
}

export async function getItemById(orgId: string, id: string): Promise<Item> {
  const { rows } = await pool.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = $1 AND org_id = $2`, [
    id,
    orgId,
  ]);
  const row = rows[0];
  // 404 rather than 403: a 403 would confirm the id exists in another tenant.
  if (row === undefined) throw new ApiError(404, 'Item not found');
  return toItem(row);
}

/**
 * Verifies a revenue/expense account belongs to this org, is the right
 * AccountType (rule 12: exactly five types, never a sixth), and is postable.
 * Runs on the caller's transaction client (rule 5).
 */
async function assertAccount(
  client: PoolClient,
  orgId: string,
  accountId: string,
  wantType: 'Revenue' | 'Expense',
): Promise<void> {
  const { rows } = await client.query<{ type: string; is_postable: boolean }>(
    'SELECT type, is_postable FROM accounts WHERE id = $1 AND org_id = $2',
    [accountId, orgId],
  );
  const account = rows[0];
  if (account === undefined) {
    throw new ApiError(422, `${wantType} account does not exist in this organization`);
  }
  if (account.type !== wantType) {
    throw new ApiError(422, `Item ${wantType.toLowerCase()} account must be a ${wantType} account`);
  }
  if (!account.is_postable) {
    throw new ApiError(422, `Item ${wantType.toLowerCase()} account must be postable`);
  }
}

export async function createItem(orgId: string, createdBy: string, input: CreateItemInput): Promise<Item> {
  try {
    const { rows } = await withTransaction(async (client) => {
      if (input.revenueAccountId !== null) await assertAccount(client, orgId, input.revenueAccountId, 'Revenue');
      if (input.expenseAccountId !== null) await assertAccount(client, orgId, input.expenseAccountId, 'Expense');

      return client.query<ItemRow>(
        `INSERT INTO items
           (org_id, created_by, code, name, description, kind, sale_price_cents, purchase_price_cents,
            revenue_account_id, expense_account_id, sale_tax_rate_bp, purchase_tax_rate_bp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${ITEM_COLUMNS}`,
        [
          orgId,
          createdBy,
          input.code,
          input.name,
          input.description,
          input.kind,
          input.salePriceCents,
          input.purchasePriceCents,
          input.revenueAccountId,
          input.expenseAccountId,
          input.saleTaxRateBp,
          input.purchaseTaxRateBp,
        ],
      );
    });
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return toItem(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Item code already exists');
    throw err;
  }
}

export async function updateItem(orgId: string, id: string, input: UpdateItemInput): Promise<Item> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence. `code` and
  // `kind` are deliberately absent — neither is updatable.
  const COLUMNS = {
    name: 'name',
    description: 'description',
    salePriceCents: 'sale_price_cents',
    purchasePriceCents: 'purchase_price_cents',
    revenueAccountId: 'revenue_account_id',
    expenseAccountId: 'expense_account_id',
    saleTaxRateBp: 'sale_tax_rate_bp',
    purchaseTaxRateBp: 'purchase_tax_rate_bp',
    isActive: 'is_active',
  } as const;

  try {
    const { rows } = await withTransaction(async (client) => {
      if (input.revenueAccountId !== undefined && input.revenueAccountId !== null) {
        await assertAccount(client, orgId, input.revenueAccountId, 'Revenue');
      }
      if (input.expenseAccountId !== undefined && input.expenseAccountId !== null) {
        await assertAccount(client, orgId, input.expenseAccountId, 'Expense');
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

      return client.query<ItemRow>(
        `UPDATE items SET ${assignments.join(', ')}
          WHERE id = $1 AND org_id = $2
          RETURNING ${ITEM_COLUMNS}`,
        values,
      );
    });

    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Item not found');
    return toItem(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Item code already exists');
    throw err;
  }
}
