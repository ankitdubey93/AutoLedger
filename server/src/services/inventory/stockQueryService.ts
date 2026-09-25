import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { averageUnitCostCents } from '../../utils/stockValuation.js';
import { LOCATION_TREE_CTE } from './locationService.js';
import type {
  StockBalance,
  StockLot,
  StockMovement,
  StockMovementType,
  StockSerial,
  StockSerialStatus,
  StockSummary,
  StockTrackingMode,
} from '../../types/inventory.js';

/**
 * Inventory (Phase 28) — the read path: balances, movement history (with
 * a running per-location quantity), lots, serials and the dashboard
 * summary. Read-only — every statement runs on `pool`.
 */

async function assertItemExists(orgId: string, itemId: string): Promise<void> {
  const { rows } = await pool.query('SELECT 1 FROM stock_items WHERE id = $1 AND org_id = $2', [itemId, orgId]);
  if (rows.length === 0) throw new ApiError(404, 'Item not found');
}

// ------------------------------------------------------------- balances

interface BalanceRow {
  item_id: string;
  item_code: string;
  item_name: string;
  uom_code: string;
  location_id: string;
  location_code: string;
  location_path: string;
  lot_id: string | null;
  lot_number: string | null;
  expires_on: string | null;
  quantity_milli: string;
  value_cents: string;
}

function toBalance(row: BalanceRow): StockBalance {
  const quantityMilli = Number(row.quantity_milli);
  const valueCents = Number(row.value_cents);
  return {
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    uomCode: row.uom_code,
    locationId: row.location_id,
    locationCode: row.location_code,
    locationPath: row.location_path,
    lotId: row.lot_id,
    lotNumber: row.lot_number,
    expiresOn: row.expires_on,
    quantityMilli,
    valueCents,
    averageUnitCostCents: averageUnitCostCents(quantityMilli, valueCents),
  };
}

export async function listBalances(
  orgId: string,
  o: { itemId: string | null; locationId: string | null; includeZero: boolean },
): Promise<StockBalance[]> {
  const clauses = ['b.org_id = $1'];
  const values: unknown[] = [orgId];

  if (!o.includeZero) clauses.push('b.quantity_milli > 0');
  if (o.itemId !== null) {
    values.push(o.itemId);
    clauses.push(`b.item_id = $${String(values.length)}`);
  }
  if (o.locationId !== null) {
    values.push(o.locationId);
    clauses.push(`b.location_id = $${String(values.length)}`);
  }

  const { rows } = await pool.query<BalanceRow>(
    `${LOCATION_TREE_CTE}
     SELECT b.item_id, i.code AS item_code, i.name AS item_name, u.code AS uom_code,
            b.location_id, loc.code AS location_code, tree.path AS location_path,
            b.lot_id, lot.lot_number, lot.expires_on,
            b.quantity_milli, b.value_cents
       FROM stock_balances b
       JOIN stock_items i ON i.id = b.item_id AND i.org_id = b.org_id
       JOIN stock_uoms u ON u.id = i.uom_id AND u.org_id = i.org_id
       JOIN stock_locations loc ON loc.id = b.location_id AND loc.org_id = b.org_id
       JOIN tree ON tree.id = b.location_id
       LEFT JOIN stock_lots lot ON lot.id = b.lot_id AND lot.org_id = b.org_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY i.code ASC, loc.code ASC`,
    values,
  );
  return rows.map(toBalance);
}

// ------------------------------------------------------------- movements

interface MovementRow {
  id: string;
  movement_group_id: string;
  movement_type: string;
  item_id: string;
  item_code: string;
  location_id: string;
  location_code: string;
  lot_id: string | null;
  lot_number: string | null;
  serial_id: string | null;
  serial_number: string | null;
  quantity_milli: string;
  value_cents: string;
  running_location_quantity_milli: string;
  reference: string | null;
  reason: string | null;
  occurred_on: string;
  source_type: string | null;
  source_id: string | null;
  gl_account_id: string | null;
  reverses_movement_id: string | null;
  created_at: Date;
}

function toMovement(row: MovementRow): StockMovement {
  return {
    id: row.id,
    movementGroupId: row.movement_group_id,
    movementType: row.movement_type as StockMovementType,
    itemId: row.item_id,
    itemCode: row.item_code,
    locationId: row.location_id,
    locationCode: row.location_code,
    lotId: row.lot_id,
    lotNumber: row.lot_number,
    serialId: row.serial_id,
    serialNumber: row.serial_number,
    quantityMilli: Number(row.quantity_milli),
    valueCents: Number(row.value_cents),
    runningLocationQuantityMilli: Number(row.running_location_quantity_milli),
    reference: row.reference,
    reason: row.reason,
    occurredOn: row.occurred_on,
    sourceType: row.source_type,
    sourceId: row.source_id,
    glAccountId: row.gl_account_id,
    reversesMovementId: row.reverses_movement_id,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listMovements(
  orgId: string,
  o: {
    itemId: string | null;
    locationId: string | null;
    movementType: StockMovementType | null;
    movementGroupId: string | null;
    from: string | null;
    to: string | null;
    page: number;
    limit: number;
  },
): Promise<{ movements: StockMovement[]; totalCount: number }> {
  const clauses = ['m.org_id = $1'];
  const values: unknown[] = [orgId];

  if (o.itemId !== null) {
    values.push(o.itemId);
    clauses.push(`m.item_id = $${String(values.length)}`);
  }
  if (o.locationId !== null) {
    values.push(o.locationId);
    clauses.push(`m.location_id = $${String(values.length)}`);
  }
  if (o.movementType !== null) {
    values.push(o.movementType);
    clauses.push(`m.movement_type = $${String(values.length)}`);
  }
  if (o.movementGroupId !== null) {
    values.push(o.movementGroupId);
    clauses.push(`m.movement_group_id = $${String(values.length)}`);
  }
  if (o.from !== null) {
    values.push(o.from);
    clauses.push(`m.occurred_on >= $${String(values.length)}`);
  }
  if (o.to !== null) {
    values.push(o.to);
    clauses.push(`m.occurred_on <= $${String(values.length)}`);
  }

  const where = clauses.join(' AND ');

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM stock_movements m WHERE ${where}`,
    values,
  );
  const totalCount = Number(countRows[0]?.count ?? '0');

  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const { rows } = await pool.query<MovementRow>(
    `SELECT w.*, i.code AS item_code, loc.code AS location_code, lot.lot_number, ser.serial_number
       FROM (
         SELECT m.*,
                SUM(m.quantity_milli) OVER (PARTITION BY m.item_id, m.location_id ORDER BY m.created_at, m.id)
                  AS running_location_quantity_milli
           FROM stock_movements m WHERE m.org_id = $1
       ) w
       JOIN stock_items i ON i.id = w.item_id AND i.org_id = $1
       JOIN stock_locations loc ON loc.id = w.location_id AND loc.org_id = $1
       LEFT JOIN stock_lots lot ON lot.id = w.lot_id AND lot.org_id = $1
       LEFT JOIN stock_serials ser ON ser.id = w.serial_id AND ser.org_id = $1
      WHERE ${where.replace(/\bm\./g, 'w.')}
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT $${String(limitIndex)} OFFSET $${String(offsetIndex)}`,
    [...values, o.limit, (o.page - 1) * o.limit],
  );

  return { movements: rows.map(toMovement), totalCount };
}

// ------------------------------------------------------------- lots & serials

interface LotRow {
  id: string;
  item_id: string;
  lot_number: string;
  manufactured_on: string | null;
  expires_on: string | null;
  created_at: Date;
  on_hand_quantity_milli: string;
}

function toLot(row: LotRow): StockLot {
  return {
    id: row.id,
    itemId: row.item_id,
    lotNumber: row.lot_number,
    manufacturedOn: row.manufactured_on,
    expiresOn: row.expires_on,
    onHandQuantityMilli: Number(row.on_hand_quantity_milli),
    createdAt: row.created_at.toISOString(),
  };
}

/** FEFO (first expired, first out): ORDER BY expires_on ASC NULLS LAST, lot_number ASC. */
export async function listItemLots(orgId: string, itemId: string): Promise<StockLot[]> {
  await assertItemExists(orgId, itemId);

  const { rows } = await pool.query<LotRow>(
    `SELECT l.id, l.item_id, l.lot_number, l.manufactured_on, l.expires_on, l.created_at,
            COALESCE((SELECT SUM(b.quantity_milli) FROM stock_balances b WHERE b.org_id = $1 AND b.lot_id = l.id), 0) AS on_hand_quantity_milli
       FROM stock_lots l
      WHERE l.org_id = $1 AND l.item_id = $2
      ORDER BY l.expires_on ASC NULLS LAST, l.lot_number ASC`,
    [orgId, itemId],
  );
  return rows.map(toLot);
}

interface SerialRow {
  id: string;
  item_id: string;
  serial_number: string;
  status: string;
  location_id: string | null;
  location_code: string | null;
  cost_cents: string;
  status_note: string | null;
  attributes: Record<string, string | boolean>;
  created_at: Date;
  updated_at: Date;
}

function toSerial(row: SerialRow): StockSerial {
  return {
    id: row.id,
    itemId: row.item_id,
    serialNumber: row.serial_number,
    status: row.status as StockSerialStatus,
    locationId: row.location_id,
    locationCode: row.location_code,
    costCents: Number(row.cost_cents),
    statusNote: row.status_note,
    attributes: row.attributes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listItemSerials(
  orgId: string,
  itemId: string,
  status: StockSerialStatus | null,
): Promise<StockSerial[]> {
  await assertItemExists(orgId, itemId);

  const clauses = ['s.org_id = $1', 's.item_id = $2'];
  const values: unknown[] = [orgId, itemId];
  if (status !== null) {
    values.push(status);
    clauses.push(`s.status = $${String(values.length)}`);
  }

  const { rows } = await pool.query<SerialRow>(
    `SELECT s.id, s.item_id, s.serial_number, s.status, s.location_id, loc.code AS location_code,
            s.cost_cents, s.status_note, s.attributes, s.created_at, s.updated_at
       FROM stock_serials s
       LEFT JOIN stock_locations loc ON loc.id = s.location_id AND loc.org_id = s.org_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.serial_number ASC`,
    values,
  );
  return rows.map(toSerial);
}

// ------------------------------------------------------------- summary

export async function getSummary(orgId: string): Promise<StockSummary> {
  const { rows } = await pool.query<{
    active_item_count: string;
    total_value_cents: string;
    low_stock_item_count: string;
    expiring_lot_count: string;
    location_count: string;
  }>(
    `SELECT
       (SELECT count(*) FROM stock_items WHERE org_id = $1 AND is_active) AS active_item_count,
       (SELECT COALESCE(SUM(value_cents), 0)::text FROM stock_balances WHERE org_id = $1) AS total_value_cents,
       (SELECT count(*) FROM stock_items i
          WHERE i.org_id = $1 AND i.reorder_point_milli IS NOT NULL
            AND COALESCE(
              (SELECT SUM(b.quantity_milli) FROM stock_balances b WHERE b.org_id = $1 AND b.item_id = i.id), 0
            ) <= i.reorder_point_milli
       ) AS low_stock_item_count,
       (SELECT count(*) FROM stock_lots l
          WHERE l.org_id = $1 AND l.expires_on BETWEEN CURRENT_DATE AND (CURRENT_DATE + 30)
            AND COALESCE(
              (SELECT SUM(b.quantity_milli) FROM stock_balances b WHERE b.org_id = $1 AND b.lot_id = l.id), 0
            ) > 0
       ) AS expiring_lot_count,
       (SELECT count(*) FROM stock_locations WHERE org_id = $1 AND is_active) AS location_count`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('getSummary produced no row');

  return {
    activeItemCount: Number(row.active_item_count),
    totalValueCents: parseCents(row.total_value_cents),
    lowStockItemCount: Number(row.low_stock_item_count),
    expiringLotCount: Number(row.expiring_lot_count),
    locationCount: Number(row.location_count),
  };
}

// ------------------------------------------------------------- product balances (Phase 32)

export interface StockProductBalance {
  ledgerItemId: string;
  stockItemId: string;
  tracking: StockTrackingMode;
  uomCode: string;
  uomDecimalPlaces: number;
  onHandQuantityMilli: number;
  isActive: boolean;
}

/**
 * On-hand quantity per LINKED item, keyed by its Accounting product id — what
 * Accounting's Products & Services list and the invoice/bill line picker show
 * beside each inventory item. Served from Inventory's own routes (the client
 * calls this API; Accounting's server never reads stock tables).
 */
export async function listProductBalances(orgId: string): Promise<StockProductBalance[]> {
  const { rows } = await pool.query<{
    ledger_item_id: string;
    id: string;
    tracking: string;
    uom_code: string;
    decimal_places: number;
    on_hand: string;
    is_active: boolean;
  }>(
    `SELECT i.ledger_item_id, i.id, i.tracking, u.code AS uom_code, u.decimal_places,
            COALESCE(SUM(b.quantity_milli), 0) AS on_hand, i.is_active
       FROM stock_items i
       JOIN stock_uoms u ON u.id = i.uom_id AND u.org_id = i.org_id
       LEFT JOIN stock_balances b ON b.item_id = i.id AND b.org_id = i.org_id
      WHERE i.org_id = $1 AND i.ledger_item_id IS NOT NULL
      GROUP BY i.ledger_item_id, i.id, i.tracking, u.code, u.decimal_places, i.is_active
      ORDER BY i.code ASC`,
    [orgId],
  );
  return rows.map((r) => ({
    ledgerItemId: r.ledger_item_id,
    stockItemId: r.id,
    tracking: r.tracking as StockTrackingMode,
    uomCode: r.uom_code,
    uomDecimalPlaces: r.decimal_places,
    onHandQuantityMilli: Number(r.on_hand),
    isActive: r.is_active,
  }));
}
