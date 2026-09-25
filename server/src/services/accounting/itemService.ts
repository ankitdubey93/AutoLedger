import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { resolveInventoryPostingAccountsOnClient } from './settingsService.js';
import * as inventoryAccountingService from './inventoryAccountingService.js';
import { ITEM_TYPES } from '../../types/accounting.js';
import type { Item, ItemKind, ItemType } from '../../types/accounting.js';

/**
 * Accounting items — "Products & Services": the one master an invoice or bill
 * line is picked from (Phase 24, extended in Phase 32).
 *
 * PHASE 32 ITEM TYPES. SERVICE and NON_INVENTORY are created here. INVENTORY
 * (and, in step 2, FIXED_ASSET) are created in Inventory, which calls
 * `createLinkedItemOnClient` inside its own transaction — this file never
 * holds quantities, movements or valuation, only the accounting identity of a
 * stock item (its inventory and COGS accounts). A stock-managed item's name
 * and active flag are owned by Inventory and pushed here by
 * `syncLinkedItemOnClient`; `updateItem` refuses to change them directly.
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

const ITEM_COLUMNS = `id, code, name, description, kind, item_type, sale_price_cents, purchase_price_cents,
                       revenue_account_id, expense_account_id, asset_account_id, cogs_account_id,
                       sale_tax_rate_bp, purchase_tax_rate_bp, is_active, created_at, updated_at`;

interface ItemRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: string;
  item_type: string;
  sale_price_cents: string | null;
  purchase_price_cents: string | null;
  revenue_account_id: string | null;
  expense_account_id: string | null;
  asset_account_id: string | null;
  cogs_account_id: string | null;
  sale_tax_rate_bp: number;
  purchase_tax_rate_bp: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function isItemKind(value: string): value is ItemKind {
  return value === 'SERVICE' || value === 'GOODS';
}

function isItemType(value: string): value is ItemType {
  return (ITEM_TYPES as readonly string[]).includes(value);
}

function isStockManaged(itemType: ItemType): boolean {
  return itemType === 'INVENTORY' || itemType === 'FIXED_ASSET';
}

function toItem(row: ItemRow): Item {
  if (!isItemKind(row.kind)) throw new Error(`Unknown item kind "${row.kind}" on item ${row.id}`);
  if (!isItemType(row.item_type)) throw new Error(`Unknown item type "${row.item_type}" on item ${row.id}`);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    itemType: row.item_type,
    stockManaged: isStockManaged(row.item_type),
    salePriceCents: row.sale_price_cents === null ? null : Number(row.sale_price_cents),
    purchasePriceCents: row.purchase_price_cents === null ? null : Number(row.purchase_price_cents),
    revenueAccountId: row.revenue_account_id,
    expenseAccountId: row.expense_account_id,
    assetAccountId: row.asset_account_id,
    cogsAccountId: row.cogs_account_id,
    saleTaxRateBp: row.sale_tax_rate_bp,
    purchaseTaxRateBp: row.purchase_tax_rate_bp,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** `kind` is derived from `itemType` — the two are never chosen independently. */
function kindFor(itemType: ItemType): ItemKind {
  return itemType === 'SERVICE' ? 'SERVICE' : 'GOODS';
}

export interface CreateItemInput {
  code: string;
  name: string;
  description: string | null;
  itemType: ItemType;
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
  assetAccountId?: string | null | undefined;
  cogsAccountId?: string | null | undefined;
  saleTaxRateBp?: number | undefined;
  purchaseTaxRateBp?: number | undefined;
  isActive?: boolean | undefined;
}

export async function listItems(
  orgId: string,
  options: { q: string | null; kind: ItemKind | null; itemType: ItemType | null; includeInactive: boolean },
): Promise<Item[]> {
  const clauses = ['org_id = $1'];
  const values: unknown[] = [orgId];

  if (!options.includeInactive) clauses.push('is_active = true');
  if (options.kind !== null) {
    values.push(options.kind);
    clauses.push(`kind = $${String(values.length)}`);
  }
  if (options.itemType !== null) {
    values.push(options.itemType);
    clauses.push(`item_type = $${String(values.length)}`);
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
  wantType: 'Revenue' | 'Expense' | 'Asset',
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
  // Stock-managed types are created in Inventory, which creates the linked
  // product here in the same transaction (createLinkedItemOnClient).
  if (isStockManaged(input.itemType)) {
    throw new ApiError(422, 'Create inventory and asset items under Products & inventory → Stock — they appear here automatically');
  }
  try {
    const { rows } = await withTransaction(async (client) => {
      if (input.revenueAccountId !== null) await assertAccount(client, orgId, input.revenueAccountId, 'Revenue');
      if (input.expenseAccountId !== null) await assertAccount(client, orgId, input.expenseAccountId, 'Expense');

      return client.query<ItemRow>(
        `INSERT INTO items
           (org_id, created_by, code, name, description, kind, item_type, sale_price_cents, purchase_price_cents,
            revenue_account_id, expense_account_id, sale_tax_rate_bp, purchase_tax_rate_bp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING ${ITEM_COLUMNS}`,
        [
          orgId,
          createdBy,
          input.code,
          input.name,
          input.description,
          kindFor(input.itemType),
          input.itemType,
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

export async function updateItem(orgId: string, userId: string, id: string, input: UpdateItemInput): Promise<Item> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence. `code`,
  // `kind` and `item_type` are deliberately absent — none is updatable.
  const COLUMNS = {
    name: 'name',
    description: 'description',
    salePriceCents: 'sale_price_cents',
    purchasePriceCents: 'purchase_price_cents',
    revenueAccountId: 'revenue_account_id',
    expenseAccountId: 'expense_account_id',
    assetAccountId: 'asset_account_id',
    cogsAccountId: 'cogs_account_id',
    saleTaxRateBp: 'sale_tax_rate_bp',
    purchaseTaxRateBp: 'purchase_tax_rate_bp',
    isActive: 'is_active',
  } as const;

  try {
    const { rows } = await withTransaction(async (client) => {
      const { rows: current } = await client.query<{ item_type: string }>(
        'SELECT item_type FROM items WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [id, orgId],
      );
      const currentType = current[0]?.item_type;
      if (currentType === undefined) throw new ApiError(404, 'Item not found');
      const managed = isItemType(currentType) && isStockManaged(currentType);
      if (managed && (input.name !== undefined || input.isActive !== undefined)) {
        throw new ApiError(422, 'Edit the name and status of inventory and asset items on their stock item');
      }
      if (!managed && (input.assetAccountId !== undefined || input.cogsAccountId !== undefined)) {
        throw new ApiError(422, 'Inventory and COGS accounts apply only to inventory and asset items');
      }
      if (input.assetAccountId !== undefined && input.assetAccountId !== null) {
        await assertAccount(client, orgId, input.assetAccountId, 'Asset');
      }
      if (input.cogsAccountId !== undefined && input.cogsAccountId !== null) {
        await assertAccount(client, orgId, input.cogsAccountId, 'Expense');
      }
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

      const updated = await client.query<ItemRow>(
        `UPDATE items SET ${assignments.join(', ')}
          WHERE id = $1 AND org_id = $2
          RETURNING ${ITEM_COLUMNS}`,
        values,
      );

      // Phase 35a: a changed inventory account moves the item's stock value
      // to it in the SAME transaction as the mapping change.
      if (input.assetAccountId !== undefined && currentType === 'INVENTORY') {
        await inventoryAccountingService.reclassToCurrentAccountsOnClient(
          client,
          orgId,
          userId,
          [id],
          'Product inventory account changed — stock value moved',
        );
      }

      return updated;
    });

    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Item not found');
    return toItem(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) throw new ApiError(409, 'Item code already exists');
    throw err;
  }
}

// ------------------------------------------------ Inventory bridge (Phase 32)

export interface CreateLinkedItemInput {
  code: string;
  name: string;
  itemType: 'INVENTORY';
  salePriceCents: number | null;
  purchasePriceCents: number | null;
  revenueAccountId: string | null;
  assetAccountId: string | null;
  cogsAccountId: string | null;
  saleTaxRateBp: number;
  purchaseTaxRateBp: number;
}

/**
 * Creates the Accounting product behind a Inventory item, on the CALLER's
 * transaction client (rule 5): a code collision rolls back the stock item and
 * its code-counter bump with it. The description stays NULL — the sales
 * description is edited in Accounting (its cap is 500 characters, Inventory's
 * is 1000).
 */
export async function createLinkedItemOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: CreateLinkedItemInput,
): Promise<Item> {
  if (input.revenueAccountId !== null) await assertAccount(client, orgId, input.revenueAccountId, 'Revenue');
  if (input.assetAccountId !== null) await assertAccount(client, orgId, input.assetAccountId, 'Asset');
  if (input.cogsAccountId !== null) await assertAccount(client, orgId, input.cogsAccountId, 'Expense');

  try {
    const { rows } = await client.query<ItemRow>(
      `INSERT INTO items
         (org_id, created_by, code, name, description, kind, item_type, sale_price_cents, purchase_price_cents,
          revenue_account_id, asset_account_id, cogs_account_id, sale_tax_rate_bp, purchase_tax_rate_bp)
       VALUES ($1, $2, $3, $4, NULL, 'GOODS', $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${ITEM_COLUMNS}`,
      [
        orgId,
        userId,
        input.code,
        input.name,
        input.itemType,
        input.salePriceCents,
        input.purchasePriceCents,
        input.revenueAccountId,
        input.assetAccountId,
        input.cogsAccountId,
        input.saleTaxRateBp,
        input.purchaseTaxRateBp,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return toItem(row);
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ApiError(409, `A product with code ${input.code} already exists in Products & Services`);
    }
    throw err;
  }
}

/** Pushes a Inventory rename / (de)activation onto the linked product. No-op when nothing changes. */
export async function syncLinkedItemOnClient(
  client: PoolClient,
  orgId: string,
  ledgerItemId: string,
  input: { name?: string | undefined; isActive?: boolean | undefined },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [ledgerItemId, orgId];
  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${String(values.length)}`);
  }
  if (input.isActive !== undefined) {
    values.push(input.isActive);
    sets.push(`is_active = $${String(values.length)}`);
  }
  if (sets.length === 0) return;
  await client.query(`UPDATE items SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, values);
}

export interface StockItemAccounts {
  itemType: ItemType;
  assetAccountId: string;
  cogsAccountId: string;
}

/**
 * For each given product id, the inventory and COGS accounts its stock posts
 * to: the item's own account first, then `ledger_settings`, then the default
 * chart code — every candidate checked for type and postability by
 * `resolveInventoryPostingAccountsOnClient`. Ids that are not stock-managed
 * products are absent from the result. Fails with a readable 422 rather than
 * guess a wrong account.
 */
export async function resolveStockAccountsOnClient(
  client: PoolClient,
  orgId: string,
  ledgerItemIds: string[],
): Promise<Map<string, StockItemAccounts>> {
  const result = new Map<string, StockItemAccounts>();
  const unique = [...new Set(ledgerItemIds)];
  if (unique.length === 0) return result;

  const { rows } = await client.query<{
    id: string;
    code: string;
    item_type: string;
    asset_account_id: string | null;
    cogs_account_id: string | null;
  }>(
    `SELECT id, code, item_type, asset_account_id, cogs_account_id FROM items
      WHERE org_id = $1 AND id = ANY($2::uuid[]) AND item_type IN ('INVENTORY', 'FIXED_ASSET')
      ORDER BY id FOR SHARE`,
    [orgId, unique],
  );
  if (rows.length === 0) return result;

  const defaults = await resolveInventoryPostingAccountsOnClient(client, orgId);
  for (const row of rows) {
    if (!isItemType(row.item_type)) continue;
    const assetAccountId = row.asset_account_id ?? defaults.inventoryAccountId;
    const cogsAccountId = row.cogs_account_id ?? defaults.cogsAccountId;
    if (assetAccountId === null) {
      throw new ApiError(422, `No inventory account is configured for item ${row.code}. Set one in settings.`);
    }
    if (cogsAccountId === null) {
      throw new ApiError(422, `No cost-of-sales account is configured for item ${row.code}. Set one in settings.`);
    }
    result.set(row.id, { itemType: row.item_type, assetAccountId, cogsAccountId });
  }
  return result;
}

// ------------------------------------------------ GL reconciliation (Phase 35a)

/** Phase 35a — accounts whose balance must equal the stock subledger (Core model §2). */
export async function resolveInventoryControlAccountIdsOnClient(
  client: Pick<PoolClient, 'query'>,
  orgId: string,
): Promise<Set<string>> {
  const { rows } = await client.query<{ asset_account_id: string }>(
    `SELECT DISTINCT asset_account_id FROM items
      WHERE org_id = $1 AND item_type = 'INVENTORY' AND asset_account_id IS NOT NULL`,
    [orgId],
  );
  const ids = new Set(rows.map((r) => r.asset_account_id));

  const { rows: defaultedRows } = await client.query<{ defaulted: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM items WHERE org_id = $1 AND item_type = 'INVENTORY' AND asset_account_id IS NULL) AS defaulted`,
    [orgId],
  );
  if (defaultedRows[0]?.defaulted === true) {
    const defaults = await resolveInventoryPostingAccountsOnClient(client, orgId);
    if (defaults.inventoryAccountId !== null) ids.add(defaults.inventoryAccountId);
  }
  return ids;
}

/** Locks the given INVENTORY products FOR UPDATE, ORDER BY id. */
export async function lockInventoryItemsOnClient(client: PoolClient, orgId: string, ledgerItemIds: string[]): Promise<void> {
  const unique = [...new Set(ledgerItemIds)];
  if (unique.length === 0) return;
  await client.query(
    `SELECT id FROM items WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [orgId, unique],
  );
}

/** Locks and returns every INVENTORY product that uses the settings default inventory account (asset_account_id IS NULL), ORDER BY id FOR UPDATE. */
export async function lockDefaultedInventoryItemsOnClient(client: PoolClient, orgId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items WHERE org_id = $1 AND item_type = 'INVENTORY' AND asset_account_id IS NULL
      ORDER BY id FOR UPDATE`,
    [orgId],
  );
  return rows.map((r) => r.id);
}

/** 422 unless the account exists in the org, is type Expense and is postable. */
export async function assertExpenseAccountOnClient(client: PoolClient, orgId: string, accountId: string): Promise<void> {
  await assertAccount(client, orgId, accountId, 'Expense');
}
