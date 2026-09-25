import { randomUUID } from 'node:crypto';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { validateAttributes } from '../../utils/stockAttributes.js';
import { isValidGtin } from '../../utils/gtin.js';
import { getActiveDefinitions } from './catalogueService.js';
import { nextCodeOnClient } from './codeSchemeService.js';
import * as ledgerItemService from '../accounting/itemService.js';
import { postLinkOpeningOnClient } from './stockGlService.js';
import { lockBalances, reclassOnClient } from './movementService.js';
import { MODULE_TAGS } from '../../config/modules.js';
import type {
  LinkAllResult,
  StockAttributeDefinition,
  StockAttributes,
  StockItem,
  StockItemType,
  StockTrackingMode,
} from '../../types/inventory.js';

/**
 * Inventory (Phase 28) — the item master.
 *
 * `code` and `category`/`itemType`/`tracking`/`uom`/`codeSchemeId` are
 * frozen once an item is created — the same posture `ledger-core/itemService.ts`
 * takes with `code`/`kind`. `attributes` PATCH replaces the whole object,
 * never merges (utils/stockAttributes.ts's own contract).
 *
 * On-hand quantity/value are a LEFT JOIN aggregate over `stock_balances`
 * (movementService.ts's derived cache), summed across every location and
 * lot for the item — not a stored column, so it is always current with the
 * movement ledger.
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

interface ItemRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category_id: string;
  category_name: string;
  item_type: string;
  tracking: string;
  uom_id: string;
  uom_code: string;
  uom_decimal_places: number;
  code_scheme_id: string | null;
  barcode: string | null;
  attributes: StockAttributes;
  reorder_point_milli: string | null;
  on_hand_quantity_milli: string;
  on_hand_value_cents: string;
  ledger_item_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const ITEM_SELECT = `
  SELECT i.id, i.code, i.name, i.description, i.category_id, c.name AS category_name, i.item_type, i.tracking,
         i.uom_id, u.code AS uom_code, u.decimal_places AS uom_decimal_places, i.code_scheme_id, i.barcode,
         i.attributes, i.reorder_point_milli, COALESCE(b.q, 0) AS on_hand_quantity_milli, COALESCE(b.v, 0) AS on_hand_value_cents,
         i.ledger_item_id, i.is_active, i.created_at, i.updated_at
    FROM stock_items i
    JOIN stock_categories c ON c.id = i.category_id AND c.org_id = i.org_id
    JOIN stock_uoms u ON u.id = i.uom_id AND u.org_id = i.org_id
    LEFT JOIN (
      SELECT item_id, SUM(quantity_milli) AS q, SUM(value_cents) AS v FROM stock_balances WHERE org_id = $1 GROUP BY item_id
    ) b ON b.item_id = i.id
`;

function toItem(row: ItemRow): StockItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    categoryId: row.category_id,
    categoryName: row.category_name,
    itemType: row.item_type as StockItemType,
    tracking: row.tracking as StockTrackingMode,
    uomId: row.uom_id,
    uomCode: row.uom_code,
    uomDecimalPlaces: row.uom_decimal_places,
    codeSchemeId: row.code_scheme_id,
    barcode: row.barcode,
    attributes: row.attributes,
    reorderPointMilli: row.reorder_point_milli === null ? null : Number(row.reorder_point_milli),
    onHandQuantityMilli: Number(row.on_hand_quantity_milli),
    onHandValueCents: Number(row.on_hand_value_cents),
    ledgerItemId: row.ledger_item_id,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ListStockItemsOptions {
  q: string | null;
  categoryId: string | null;
  itemType: StockItemType | null;
  tracking: StockTrackingMode | null;
  includeInactive: boolean;
  lowStock: boolean;
  page: number;
  limit: number;
}

export async function listItems(
  orgId: string,
  o: ListStockItemsOptions,
): Promise<{ items: StockItem[]; totalCount: number }> {
  const clauses = ['i.org_id = $1'];
  const values: unknown[] = [orgId];

  if (!o.includeInactive) clauses.push('i.is_active = true');
  if (o.categoryId !== null) {
    values.push(o.categoryId);
    clauses.push(`i.category_id = $${String(values.length)}`);
  }
  if (o.itemType !== null) {
    values.push(o.itemType);
    clauses.push(`i.item_type = $${String(values.length)}`);
  }
  if (o.tracking !== null) {
    values.push(o.tracking);
    clauses.push(`i.tracking = $${String(values.length)}`);
  }
  if (o.q !== null) {
    values.push(o.q);
    const p = `$${String(values.length)}`;
    clauses.push(`(i.code ILIKE '%' || ${p} || '%' OR i.name ILIKE '%' || ${p} || '%' OR i.barcode ILIKE '%' || ${p} || '%')`);
  }
  if (o.lowStock) {
    clauses.push(
      `i.reorder_point_milli IS NOT NULL AND COALESCE(
         (SELECT SUM(quantity_milli) FROM stock_balances WHERE org_id = $1 AND item_id = i.id), 0
       ) <= i.reorder_point_milli`,
    );
  }

  const where = clauses.join(' AND ');

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM stock_items i WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.count ?? '0');

  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const { rows } = await pool.query<ItemRow>(
    `${ITEM_SELECT} WHERE ${where} ORDER BY i.code ASC, i.id ASC LIMIT $${String(limitIndex)} OFFSET $${String(offsetIndex)}`,
    [...values, o.limit, (o.page - 1) * o.limit],
  );

  return { items: rows.map(toItem), totalCount };
}

export async function getItem(
  orgId: string,
  id: string,
): Promise<{ item: StockItem; attributes: StockAttributeDefinition[]; serialAttributes: StockAttributeDefinition[] }> {
  const { rows } = await pool.query<ItemRow>(`${ITEM_SELECT} WHERE i.org_id = $1 AND i.id = $2`, [orgId, id]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Item not found');

  const item = toItem(row);
  const attributes = await getActiveDefinitions(pool, orgId, item.categoryId, 'ITEM');
  const serialAttributes = await getActiveDefinitions(pool, orgId, item.categoryId, 'SERIAL');
  return { item, attributes, serialAttributes };
}

export interface CreateStockItemInput {
  name: string;
  description: string | null;
  categoryId: string;
  uomId: string | null;
  tracking: StockTrackingMode | null;
  code: string | null;
  codeSchemeId: string | null;
  barcode: string | null;
  attributes: Record<string, unknown>;
  reorderPointMilli: number | null;
  /** Phase 32: the accounting side of the linked Accounting product. Omitted = no prices, default accounts. */
  product?: StockItemProductInput | undefined;
}

/** The accounting identity a stock item carries into Products & Services. */
export interface StockItemProductInput {
  salePriceCents: number | null;
  purchasePriceCents: number | null;
  revenueAccountId: string | null;
  assetAccountId: string | null;
  cogsAccountId: string | null;
  saleTaxRateBp: number;
  purchaseTaxRateBp: number;
}

const EMPTY_PRODUCT: StockItemProductInput = {
  salePriceCents: null,
  purchasePriceCents: null,
  revenueAccountId: null,
  assetAccountId: null,
  cogsAccountId: null,
  saleTaxRateBp: 0,
  purchaseTaxRateBp: 0,
};

export async function createItem(orgId: string, userId: string, input: CreateStockItemInput): Promise<StockItem> {
  try {
    const { rows } = await withTransaction(async (client) => {
      const { rows: categoryRows } = await client.query<{
        id: string;
        code: string;
        item_type: string;
        default_tracking: string;
        default_uom_id: string | null;
        is_active: boolean;
      }>(
        'SELECT id, code, item_type, default_tracking, default_uom_id, is_active FROM stock_categories WHERE id = $1 AND org_id = $2',
        [input.categoryId, orgId],
      );
      const category = categoryRows[0];
      if (category === undefined) throw new ApiError(422, 'Category does not exist in this organization');
      if (!category.is_active) throw new ApiError(422, 'Category is inactive');

      const uomId = input.uomId ?? category.default_uom_id;
      if (uomId === null) throw new ApiError(422, 'Choose a unit of measure');

      const { rows: uomRows } = await client.query<{ decimal_places: number; is_active: boolean }>(
        'SELECT decimal_places, is_active FROM stock_uoms WHERE id = $1 AND org_id = $2',
        [uomId, orgId],
      );
      const uom = uomRows[0];
      if (uom === undefined || !uom.is_active) {
        throw new ApiError(422, 'Unit of measure does not exist in this organization');
      }

      const tracking = (input.tracking ?? category.default_tracking) as StockTrackingMode;
      if (tracking === 'SERIAL' && uom.decimal_places !== 0) {
        throw new ApiError(422, 'Serial-tracked items need a whole-number unit of measure');
      }

      const definitions = await getActiveDefinitions(client, orgId, input.categoryId, 'ITEM');
      const validated = validateAttributes(definitions, input.attributes);
      if (!validated.ok) throw new ApiError(422, `Invalid attributes: ${validated.errors.join('; ')}`);

      if (input.barcode !== null && !isValidGtin(input.barcode)) {
        throw new ApiError(422, 'Barcode check digit is invalid');
      }

      let code: string;
      let codeSchemeId: string | null;
      if (input.code !== null) {
        code = input.code;
        codeSchemeId = null;
      } else {
        let schemeId = input.codeSchemeId;
        if (schemeId === null) {
          const { rows: defaultRows } = await client.query<{ id: string }>(
            'SELECT id FROM stock_code_schemes WHERE org_id = $1 AND is_default',
            [orgId],
          );
          schemeId = defaultRows[0]?.id ?? null;
          if (schemeId === null) throw new ApiError(422, 'Provide a code or configure a default code scheme');
        }
        code = await nextCodeOnClient(client, orgId, schemeId, {
          categoryCode: category.code,
          attributes: validated.value,
          date: new Date(),
        });
        codeSchemeId = schemeId;
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO stock_items
           (org_id, code, name, description, category_id, item_type, tracking, uom_id, code_scheme_id,
            barcode, attributes, reorder_point_milli, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
         RETURNING id`,
        [
          orgId,
          code,
          input.name,
          input.description,
          input.categoryId,
          category.item_type,
          tracking,
          uomId,
          codeSchemeId,
          input.barcode,
          JSON.stringify(validated.value),
          input.reorderPointMilli,
          userId,
        ],
      );

      // Phase 32: every stock item is born linked to a Accounting product, in the
      // SAME transaction — a code collision in Products & Services rolls back this
      // insert and the code-counter bump above with it (rule 5).
      const product = input.product ?? EMPTY_PRODUCT;
      const created = inserted.rows[0];
      if (created === undefined) throw new Error('INSERT ... RETURNING produced no row');
      const ledgerItem = await ledgerItemService.createLinkedItemOnClient(client, orgId, userId, {
        code,
        name: input.name,
        itemType: 'INVENTORY',
        ...product,
      });
      await client.query('UPDATE stock_items SET ledger_item_id = $3 WHERE id = $1 AND org_id = $2', [
        created.id,
        orgId,
        ledgerItem.id,
      ]);
      return inserted;
    });

    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    const { item } = await getItem(orgId, row.id);
    return item;
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      if (pgConstraint(err) === 'ux_stock_items_org_barcode') throw new ApiError(409, 'Barcode already used by another item');
      throw new ApiError(409, 'Item code already exists');
    }
    throw err;
  }
}

export interface UpdateStockItemInput {
  name?: string | undefined;
  description?: string | null | undefined;
  barcode?: string | null | undefined;
  attributes?: Record<string, unknown> | undefined;
  reorderPointMilli?: number | null | undefined;
  isActive?: boolean | undefined;
}

export async function updateItem(orgId: string, id: string, input: UpdateStockItemInput): Promise<StockItem> {
  try {
    await withTransaction(async (client) => {
      const { rows: existingRows } = await client.query<{ category_id: string; ledger_item_id: string | null }>(
        'SELECT category_id, ledger_item_id FROM stock_items WHERE id = $1 AND org_id = $2',
        [id, orgId],
      );
      const existing = existingRows[0];
      if (existing === undefined) throw new ApiError(404, 'Item not found');

      let attributesJson: string | undefined;
      if (input.attributes !== undefined) {
        const definitions = await getActiveDefinitions(client, orgId, existing.category_id, 'ITEM');
        const validated = validateAttributes(definitions, input.attributes);
        if (!validated.ok) throw new ApiError(422, `Invalid attributes: ${validated.errors.join('; ')}`);
        attributesJson = JSON.stringify(validated.value);
      }

      if (input.barcode !== undefined && input.barcode !== null && !isValidGtin(input.barcode)) {
        throw new ApiError(422, 'Barcode check digit is invalid');
      }

      const assignments: string[] = [];
      const values: unknown[] = [id, orgId];

      if (input.name !== undefined) {
        values.push(input.name);
        assignments.push(`name = $${String(values.length)}`);
      }
      if (input.description !== undefined) {
        values.push(input.description);
        assignments.push(`description = $${String(values.length)}`);
      }
      if (input.barcode !== undefined) {
        values.push(input.barcode);
        assignments.push(`barcode = $${String(values.length)}`);
      }
      if (attributesJson !== undefined) {
        values.push(attributesJson);
        assignments.push(`attributes = $${String(values.length)}::jsonb`);
      }
      if (input.reorderPointMilli !== undefined) {
        values.push(input.reorderPointMilli);
        assignments.push(`reorder_point_milli = $${String(values.length)}`);
      }
      if (input.isActive !== undefined) {
        values.push(input.isActive);
        assignments.push(`is_active = $${String(values.length)}`);
      }
      if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

      const { rows } = await client.query<{ id: string }>(
        `UPDATE stock_items SET ${assignments.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING id`,
        values,
      );
      if (rows[0] === undefined) throw new ApiError(404, 'Item not found');

      // Name and status are owned here; push them onto the linked product.
      if (existing.ledger_item_id !== null) {
        await ledgerItemService.syncLinkedItemOnClient(client, orgId, existing.ledger_item_id, {
          name: input.name,
          isActive: input.isActive,
        });
      }
    });
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      if (pgConstraint(err) === 'ux_stock_items_org_barcode') throw new ApiError(409, 'Barcode already used by another item');
      throw new ApiError(409, 'Item code already exists');
    }
    throw err;
  }

  const { item } = await getItem(orgId, id);
  return item;
}

/**
 * Links an item created before Phase 32 (or never linked) to a new Accounting
 * product. If it already holds stock, posts the opening entry — Dr Inventory /
 * Cr Opening-stock equity — so the GL inventory account starts equal to
 * Inventory's valuation. Not done in a migration: a code can collide with an
 * existing product (a person decides), and the opening entry needs a user, an
 * open period and the audit context.
 */
export async function linkProduct(
  orgId: string,
  userId: string,
  id: string,
  product: StockItemProductInput,
): Promise<StockItem> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ code: string; name: string; ledger_item_id: string | null }>(
      'SELECT code, name, ledger_item_id FROM stock_items WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [id, orgId],
    );
    const item = rows[0];
    if (item === undefined) throw new ApiError(404, 'Item not found');
    if (item.ledger_item_id !== null) throw new ApiError(409, 'Item is already linked to a product');

    const ledgerItem = await ledgerItemService.createLinkedItemOnClient(client, orgId, userId, {
      code: item.code,
      name: item.name,
      itemType: 'INVENTORY',
      ...product,
    });
    await client.query('UPDATE stock_items SET ledger_item_id = $3 WHERE id = $1 AND org_id = $2', [
      id,
      orgId,
      ledgerItem.id,
    ]);

    // Phase 35a: lock every balance of the item so the opening journal and the
    // RECLASS pair below agree on the same locked on-hand value.
    const { rows: balanceRows } = await client.query<{ location_id: string; lot_id: string | null }>(
      'SELECT location_id, lot_id FROM stock_balances WHERE org_id = $1 AND item_id = $2',
      [orgId, id],
    );
    const balances = await lockBalances(
      client,
      orgId,
      balanceRows.map((r) => ({ itemId: id, locationId: r.location_id, lotId: r.lot_id })),
    );
    let onHandValueCents = 0;
    let anchor: { locationId: string; lotId: string | null } | undefined;
    for (const [key, bal] of balances) {
      onHandValueCents += bal.valueCents;
      if (anchor === undefined) {
        const parts = key.split('|');
        const locationId = parts[1];
        const lot = parts[2];
        if (locationId !== undefined) anchor = { locationId, lotId: lot === undefined || lot === '' ? null : lot };
      }
    }

    if (onHandValueCents > 0) {
      const accounts = await ledgerItemService.resolveStockAccountsOnClient(client, orgId, [ledgerItem.id]);
      const inventoryAccountId = accounts.get(ledgerItem.id)?.assetAccountId;
      if (inventoryAccountId === undefined) throw new Error('linked product did not resolve inventory accounts');
      if (anchor === undefined) throw new Error('item has on-hand value but no balance row');
      const today = new Date().toISOString().slice(0, 10);
      await postLinkOpeningOnClient(client, orgId, userId, id, inventoryAccountId, onHandValueCents, today, item.code);
      // Phase 35a: the stock ledger already carried this value with no GL
      // account (gl_account_id NULL) — the RECLASS pair below is what makes
      // Σ movements on the inventory account agree with the opening journal.
      await reclassOnClient(
        client,
        orgId,
        userId,
        randomUUID(),
        [
          {
            itemId: id,
            locationId: anchor.locationId,
            lotId: anchor.lotId,
            fromAccountId: null,
            toAccountId: inventoryAccountId,
            valueCents: onHandValueCents,
          },
        ],
        today,
        'Link to general ledger',
        { type: MODULE_TAGS.inventory, id },
      );
    }
  });

  const { item } = await getItem(orgId, id);
  return item;
}

/**
 * Phase 35a — links every unlinked stock item to a new Products & Services
 * entry, oldest code first. Each link runs in its own transaction (via
 * `linkProduct`), so a code collision on one item does not roll back the
 * rest — its failure is recorded and the loop continues.
 */
export async function linkAllProducts(orgId: string, userId: string): Promise<LinkAllResult> {
  const { rows } = await pool.query<{ id: string; code: string }>(
    'SELECT id, code FROM stock_items WHERE org_id = $1 AND ledger_item_id IS NULL ORDER BY code',
    [orgId],
  );

  let linkedCount = 0;
  const failures: LinkAllResult['failures'] = [];
  for (const row of rows) {
    try {
      await linkProduct(orgId, userId, row.id, EMPTY_PRODUCT);
      linkedCount += 1;
    } catch (err) {
      if (err instanceof ApiError) {
        failures.push({ stockItemId: row.id, code: row.code, message: err.message });
        continue;
      }
      throw err;
    }
  }
  return { linkedCount, failures };
}
