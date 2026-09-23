import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { cents, scaleCents } from '../../utils/money.js';
import { outflowValueCents, receiptValueCents } from '../../utils/stockValuation.js';
import { validateAttributes } from '../../utils/stockAttributes.js';
import { getActiveDefinitions } from './catalogueService.js';
import { getLocationOnClient } from './locationService.js';
import { canTransitionSerial } from '../../types/stock.js';
import type { StockMovement, StockMovementType, StockSerialStatus, StockTrackingMode } from '../../types/stock.js';

/**
 * StockLedger (Phase 28) — the movement write path: receive, issue,
 * transfer, adjust. Every query in this file runs on the transaction
 * `client` passed to `withTransaction`, never on `pool` directly (rule 5) —
 * that is what makes a rolled-back call also roll back its counter bumps
 * and balance changes atomically.
 *
 * VALUATION-ORDER RULING: movements are valued in PROCESSING order, not
 * `occurred_on` order. A back-dated receipt does not re-cost issues already
 * made against the balance it retroactively affects — a named, deliberate
 * gap (docs/stock.md).
 *
 * DETERMINISTIC LOCK ORDER (deadlock avoidance): every balance row this
 * call will touch is upserted-then-locked in one pass, sorted by
 * (itemId, locationId, lotId ?? ''), before any value is computed or any
 * row is written. Two concurrent multi-line calls that touch the same
 * items/locations in different request order therefore always attempt to
 * acquire those locks in the SAME order, so neither can hold a lock the
 * other needs while waiting on a lock it holds — the standard fix for a
 * lock-ordering deadlock (study/postgresql/transactions-isolation-pooling.md).
 * Do not change this order. Serials are locked in a second pass, sorted by
 * id, after every balance lock is held.
 */

// ------------------------------------------------------------- shared helpers

function assertNotFuture(occurredOn: string): void {
  const today = new Date().toISOString().slice(0, 10);
  if (occurredOn > today) throw new ApiError(422, 'Movement date cannot be in the future');
}

interface ItemInfo {
  id: string;
  code: string;
  tracking: StockTrackingMode;
  isActive: boolean;
  categoryId: string;
  decimalPlaces: number;
}

async function loadItems(client: PoolClient, orgId: string, itemIds: string[]): Promise<Map<string, ItemInfo>> {
  const unique = [...new Set(itemIds)];
  const { rows } = await client.query<{
    id: string;
    code: string;
    tracking: string;
    is_active: boolean;
    category_id: string;
    decimal_places: number;
  }>(
    `SELECT i.id, i.code, i.tracking, i.is_active, i.category_id, u.decimal_places
       FROM stock_items i JOIN stock_uoms u ON u.id = i.uom_id AND u.org_id = i.org_id
      WHERE i.org_id = $1 AND i.id = ANY($2::uuid[])`,
    [orgId, unique],
  );
  const map = new Map<string, ItemInfo>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      code: row.code,
      tracking: row.tracking as StockTrackingMode,
      isActive: row.is_active,
      categoryId: row.category_id,
      decimalPlaces: row.decimal_places,
    });
  }
  if (map.size !== unique.length) throw new ApiError(422, 'Item does not exist in this organization');
  return map;
}

function assertQuantityPrecision(item: ItemInfo, quantityMilli: number): void {
  const modulus = 10 ** (3 - item.decimalPlaces);
  if (quantityMilli % modulus !== 0) {
    throw new ApiError(422, `Quantity for item ${item.code} allows at most ${item.decimalPlaces} decimal places`);
  }
}

async function assertLocationActive(
  client: PoolClient,
  orgId: string,
  locationId: string,
): Promise<{ id: string; code: string; isActive: boolean }> {
  const location = await getLocationOnClient(client, orgId, locationId);
  if (!location.isActive) throw new ApiError(422, 'Location is inactive');
  return location;
}

async function resolveLotForReceipt(
  client: PoolClient,
  orgId: string,
  userId: string,
  itemId: string,
  lot: { lotNumber: string; manufacturedOn: string | null; expiresOn: string | null },
): Promise<{ id: string; lotNumber: string }> {
  const { rows } = await client.query<{ id: string; expires_on: string | null }>(
    'SELECT id, expires_on FROM stock_lots WHERE org_id = $1 AND item_id = $2 AND lot_number = $3',
    [orgId, itemId, lot.lotNumber],
  );
  const existing = rows[0];
  if (existing !== undefined) {
    if ((existing.expires_on ?? null) !== (lot.expiresOn ?? null)) {
      throw new ApiError(422, `Lot ${lot.lotNumber} already exists with a different expiry date`);
    }
    return { id: existing.id, lotNumber: lot.lotNumber };
  }

  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO stock_lots (org_id, item_id, lot_number, manufactured_on, expires_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [orgId, itemId, lot.lotNumber, lot.manufacturedOn, lot.expiresOn, userId],
  );
  const row = inserted[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
  return { id: row.id, lotNumber: lot.lotNumber };
}

async function resolveExistingLot(
  client: PoolClient,
  orgId: string,
  itemId: string,
  lotId: string,
): Promise<{ id: string; lotNumber: string }> {
  const { rows } = await client.query<{ lot_number: string }>(
    'SELECT lot_number FROM stock_lots WHERE id = $1 AND org_id = $2 AND item_id = $3',
    [lotId, orgId, itemId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(422, 'Lot does not exist for this item');
  return { id: lotId, lotNumber: row.lot_number };
}

// ------------------------------------------------------------- balance & serial locking

interface BalanceState {
  id: string;
  quantityMilli: number;
  valueCents: number;
}

function balanceKey(itemId: string, locationId: string, lotId: string | null): string {
  return `${itemId}|${locationId}|${lotId ?? ''}`;
}

async function lockBalances(
  client: PoolClient,
  orgId: string,
  keys: { itemId: string; locationId: string; lotId: string | null }[],
): Promise<Map<string, BalanceState>> {
  const seen = new Set<string>();
  const unique = keys.filter((k) => {
    const key = balanceKey(k.itemId, k.locationId, k.lotId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Deterministic order — see the file header. Never change this comparator.
  unique.sort((a, b) => {
    if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
    if (a.locationId !== b.locationId) return a.locationId < b.locationId ? -1 : 1;
    const la = a.lotId ?? '';
    const lb = b.lotId ?? '';
    return la < lb ? -1 : la > lb ? 1 : 0;
  });

  const map = new Map<string, BalanceState>();
  for (const k of unique) {
    await client.query(
      `INSERT INTO stock_balances (org_id, item_id, location_id, lot_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT ux_stock_balances_key DO NOTHING`,
      [orgId, k.itemId, k.locationId, k.lotId],
    );
    const { rows } = await client.query<{ id: string; quantity_milli: string; value_cents: string }>(
      `SELECT id, quantity_milli, value_cents FROM stock_balances
        WHERE org_id = $1 AND item_id = $2 AND location_id = $3 AND lot_id IS NOT DISTINCT FROM $4
          FOR UPDATE`,
      [orgId, k.itemId, k.locationId, k.lotId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('stock_balances upsert produced no row');
    map.set(balanceKey(k.itemId, k.locationId, k.lotId), {
      id: row.id,
      quantityMilli: Number(row.quantity_milli),
      valueCents: Number(row.value_cents),
    });
  }
  return map;
}

interface SerialState {
  id: string;
  itemId: string;
  serialNumber: string;
  status: StockSerialStatus;
  locationId: string | null;
  costCents: number;
}

async function lockSerials(client: PoolClient, orgId: string, ids: string[]): Promise<Map<string, SerialState>> {
  const unique = [...new Set(ids)];
  const map = new Map<string, SerialState>();
  if (unique.length === 0) return map;

  const { rows } = await client.query<{
    id: string;
    item_id: string;
    serial_number: string;
    status: string;
    location_id: string | null;
    cost_cents: string;
  }>(
    `SELECT id, item_id, serial_number, status, location_id, cost_cents FROM stock_serials
      WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [orgId, unique],
  );
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      itemId: row.item_id,
      serialNumber: row.serial_number,
      status: row.status as StockSerialStatus,
      locationId: row.location_id,
      costCents: Number(row.cost_cents),
    });
  }
  return map;
}

// ------------------------------------------------------------- persistence

interface MovementSpec {
  movementType: StockMovementType;
  itemId: string;
  itemCode: string;
  locationId: string;
  locationCode: string;
  lotId: string | null;
  lotNumber: string | null;
  serialId: string | null;
  serialNumber: string | null;
  quantityMilli: number; // signed
  valueCents: number; // signed
  reference: string | null;
  reason: string | null;
  occurredOn: string;
}

async function insertMovement(
  client: PoolClient,
  orgId: string,
  userId: string,
  movementGroupId: string,
  spec: MovementSpec,
  balances: Map<string, BalanceState>,
): Promise<StockMovement> {
  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO stock_movements
       (org_id, movement_group_id, movement_type, item_id, location_id, lot_id, serial_id,
        quantity_milli, value_cents, reference, reason, occurred_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, created_at`,
    [
      orgId,
      movementGroupId,
      spec.movementType,
      spec.itemId,
      spec.locationId,
      spec.lotId,
      spec.serialId,
      spec.quantityMilli,
      spec.valueCents,
      spec.reference,
      spec.reason,
      spec.occurredOn,
      userId,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');

  const key = balanceKey(spec.itemId, spec.locationId, spec.lotId);
  const bal = balances.get(key);
  if (bal === undefined) throw new Error(`balance not locked for key ${key}`);

  await client.query('UPDATE stock_balances SET quantity_milli = quantity_milli + $3, value_cents = value_cents + $4 WHERE id = $1 AND org_id = $2', [
    bal.id,
    orgId,
    spec.quantityMilli,
    spec.valueCents,
  ]);
  bal.quantityMilli += spec.quantityMilli;
  bal.valueCents += spec.valueCents;

  return {
    id: row.id,
    movementGroupId,
    movementType: spec.movementType,
    itemId: spec.itemId,
    itemCode: spec.itemCode,
    locationId: spec.locationId,
    locationCode: spec.locationCode,
    lotId: spec.lotId,
    lotNumber: spec.lotNumber,
    serialId: spec.serialId,
    serialNumber: spec.serialNumber,
    quantityMilli: spec.quantityMilli,
    valueCents: spec.valueCents,
    runningLocationQuantityMilli: bal.quantityMilli,
    reference: spec.reference,
    reason: spec.reason,
    occurredOn: spec.occurredOn,
    createdAt: row.created_at.toISOString(),
  };
}

// ------------------------------------------------------------- public API

export interface ReceiptLineInput {
  itemId: string;
  quantityMilli: number;
  unitCostCents: number;
  lot: { lotNumber: string; manufacturedOn: string | null; expiresOn: string | null } | null;
  serials: { serialNumber: string; costCents: number | null; attributes: Record<string, unknown> }[] | null;
}

export interface OutboundLineInput {
  itemId: string;
  quantityMilli: number;
  lotId: string | null;
  serialIds: string[] | null;
}

export interface AdjustmentLineInput {
  itemId: string;
  direction: 'IN' | 'OUT';
  quantityMilli: number;
  lotId: string | null;
  unitCostCents: number | null;
}

export interface MovementResult {
  movementGroupId: string;
  movements: StockMovement[];
}

export async function receive(
  orgId: string,
  userId: string,
  input: { occurredOn: string; reference: string | null; locationId: string; lines: ReceiptLineInput[] },
): Promise<MovementResult> {
  assertNotFuture(input.occurredOn);
  const movementGroupId = randomUUID();

  const movements = await withTransaction(async (client) => {
    const location = await assertLocationActive(client, orgId, input.locationId);
    const items = await loadItems(client, orgId, input.lines.map((l) => l.itemId));

    interface Job {
      item: ItemInfo;
      quantityMilli: number;
      valueCents: number;
      lotId: string | null;
      lotNumber: string | null;
      serial: {
        id: string | null;
        serialNumber: string;
        costCents: number;
        attributes: Record<string, unknown>;
        isReReceive: boolean;
      } | null;
    }
    const jobs: Job[] = [];
    const balanceKeys: { itemId: string; locationId: string; lotId: string | null }[] = [];
    const existingSerialIds: string[] = [];

    for (const line of input.lines) {
      const item = items.get(line.itemId);
      if (item === undefined) throw new ApiError(422, 'Item does not exist in this organization');
      if (!item.isActive) throw new ApiError(422, `Item ${item.code} is inactive`);

      if (item.tracking === 'LOT') {
        if (line.serials !== null) throw new ApiError(422, `Item ${item.code} is not serial-tracked`);
        if (line.lot === null) throw new ApiError(422, `Lot-tracked item ${item.code} needs a lot`);
        assertQuantityPrecision(item, line.quantityMilli);

        const lot = await resolveLotForReceipt(client, orgId, userId, item.id, line.lot);
        const value = receiptValueCents(line.unitCostCents, line.quantityMilli);
        jobs.push({ item, quantityMilli: line.quantityMilli, valueCents: value, lotId: lot.id, lotNumber: lot.lotNumber, serial: null });
        balanceKeys.push({ itemId: item.id, locationId: location.id, lotId: lot.id });
      } else if (item.tracking === 'SERIAL') {
        if (line.lot !== null) throw new ApiError(422, `Item ${item.code} is not lot-tracked`);
        const serialLines = line.serials ?? [];
        if (serialLines.length * 1000 !== line.quantityMilli) {
          throw new ApiError(422, `Serial-tracked item ${item.code} needs one serial per unit`);
        }

        for (const s of serialLines) {
          const { rows: existingRows } = await client.query<{ id: string }>(
            'SELECT id FROM stock_serials WHERE org_id = $1 AND item_id = $2 AND serial_number = $3',
            [orgId, item.id, s.serialNumber],
          );
          const existing = existingRows[0];
          if (existing !== undefined) existingSerialIds.push(existing.id);

          jobs.push({
            item,
            quantityMilli: 1000,
            valueCents: s.costCents ?? line.unitCostCents,
            lotId: null,
            lotNumber: null,
            serial: {
              id: existing?.id ?? null,
              serialNumber: s.serialNumber,
              costCents: s.costCents ?? line.unitCostCents,
              attributes: s.attributes,
              isReReceive: existing !== undefined,
            },
          });
        }
        balanceKeys.push({ itemId: item.id, locationId: location.id, lotId: null });
      } else {
        if (line.lot !== null) throw new ApiError(422, `Item ${item.code} is not lot-tracked`);
        if (line.serials !== null) throw new ApiError(422, `Item ${item.code} is not serial-tracked`);
        assertQuantityPrecision(item, line.quantityMilli);

        const value = receiptValueCents(line.unitCostCents, line.quantityMilli);
        jobs.push({ item, quantityMilli: line.quantityMilli, valueCents: value, lotId: null, lotNumber: null, serial: null });
        balanceKeys.push({ itemId: item.id, locationId: location.id, lotId: null });
      }
    }

    const balances = await lockBalances(client, orgId, balanceKeys);
    const serials = await lockSerials(client, orgId, existingSerialIds);

    const results: StockMovement[] = [];
    for (const job of jobs) {
      let serialId: string | null = null;
      let serialNumber: string | null = null;

      if (job.serial !== null) {
        const definitions = await getActiveDefinitions(client, orgId, job.item.categoryId, 'SERIAL');
        const validated = validateAttributes(definitions, job.serial.attributes);
        if (!validated.ok) {
          throw new ApiError(422, `Invalid attributes for serial ${job.serial.serialNumber}: ${validated.errors.join('; ')}`);
        }

        if (job.serial.isReReceive) {
          const locked = serials.get(job.serial.id as string);
          if (locked === undefined) throw new Error('serial not locked');
          if (!canTransitionSerial(locked.status, 'AVAILABLE', 'MOVEMENT')) {
            throw new ApiError(409, `Serial ${job.serial.serialNumber} is already in stock`);
          }
          await client.query(
            `UPDATE stock_serials SET status = 'AVAILABLE', location_id = $3, cost_cents = $4, attributes = $5::jsonb
              WHERE id = $1 AND org_id = $2`,
            [locked.id, orgId, location.id, job.serial.costCents, JSON.stringify(validated.value)],
          );
          serialId = locked.id;
        } else {
          const { rows: insertedSerial } = await client.query<{ id: string }>(
            `INSERT INTO stock_serials (org_id, item_id, serial_number, status, location_id, cost_cents, attributes, created_by)
             VALUES ($1, $2, $3, 'AVAILABLE', $4, $5, $6::jsonb, $7) RETURNING id`,
            [orgId, job.item.id, job.serial.serialNumber, location.id, job.serial.costCents, JSON.stringify(validated.value), userId],
          );
          const row = insertedSerial[0];
          if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
          serialId = row.id;
        }
        serialNumber = job.serial.serialNumber;
      }

      const movement = await insertMovement(
        client,
        orgId,
        userId,
        movementGroupId,
        {
          movementType: 'RECEIPT',
          itemId: job.item.id,
          itemCode: job.item.code,
          locationId: location.id,
          locationCode: location.code,
          lotId: job.lotId,
          lotNumber: job.lotNumber,
          serialId,
          serialNumber,
          quantityMilli: job.quantityMilli,
          valueCents: job.valueCents,
          reference: input.reference,
          reason: null,
          occurredOn: input.occurredOn,
        },
        balances,
      );
      results.push(movement);
    }

    return results;
  });

  return { movementGroupId, movements };
}

export async function issue(
  orgId: string,
  userId: string,
  input: { occurredOn: string; reference: string | null; locationId: string; lines: OutboundLineInput[] },
): Promise<MovementResult> {
  assertNotFuture(input.occurredOn);
  const movementGroupId = randomUUID();

  const movements = await withTransaction(async (client) => {
    // Outbound movements from an inactive location are allowed — no active check.
    const location = await getLocationOnClient(client, orgId, input.locationId);
    const items = await loadItems(client, orgId, input.lines.map((l) => l.itemId));

    interface Job {
      item: ItemInfo;
      quantityMilli: number;
      lot: { id: string; lotNumber: string } | null;
      serialIds: string[] | null;
    }
    const jobs: Job[] = [];
    const balanceKeys: { itemId: string; locationId: string; lotId: string | null }[] = [];
    const serialIdsToLock: string[] = [];

    for (const line of input.lines) {
      const item = items.get(line.itemId);
      if (item === undefined) throw new ApiError(422, 'Item does not exist in this organization');

      if (item.tracking === 'LOT') {
        if (line.serialIds !== null) throw new ApiError(422, `Item ${item.code} is not serial-tracked`);
        if (line.lotId === null) throw new ApiError(422, `Lot-tracked item ${item.code} needs a lot`);
        assertQuantityPrecision(item, line.quantityMilli);

        const lot = await resolveExistingLot(client, orgId, item.id, line.lotId);
        jobs.push({ item, quantityMilli: line.quantityMilli, lot, serialIds: null });
        balanceKeys.push({ itemId: item.id, locationId: location.id, lotId: lot.id });
      } else if (item.tracking === 'SERIAL') {
        if (line.lotId !== null) throw new ApiError(422, `Item ${item.code} is not lot-tracked`);
        const ids = line.serialIds ?? [];
        if (ids.length * 1000 !== line.quantityMilli) {
          throw new ApiError(422, `Serial-tracked item ${item.code} needs one serial per unit`);
        }
        jobs.push({ item, quantityMilli: line.quantityMilli, lot: null, serialIds: ids });
        balanceKeys.push({ itemId: item.id, locationId: location.id, lotId: null });
        serialIdsToLock.push(...ids);
      } else {
        if (line.lotId !== null) throw new ApiError(422, `Item ${item.code} is not lot-tracked`);
        if (line.serialIds !== null) throw new ApiError(422, `Item ${item.code} is not serial-tracked`);
        assertQuantityPrecision(item, line.quantityMilli);

        jobs.push({ item, quantityMilli: line.quantityMilli, lot: null, serialIds: null });
        balanceKeys.push({ itemId: item.id, locationId: location.id, lotId: null });
      }
    }

    const balances = await lockBalances(client, orgId, balanceKeys);
    const serials = await lockSerials(client, orgId, serialIdsToLock);

    const results: StockMovement[] = [];
    for (const job of jobs) {
      if (job.serialIds !== null) {
        for (const serialId of job.serialIds) {
          const locked = serials.get(serialId);
          if (locked === undefined || locked.itemId !== job.item.id) {
            throw new ApiError(422, 'Serial does not exist for this item');
          }
          // ISSUED is checked before the location match: an ISSUED serial
          // structurally carries a NULL location_id (ck_stock_serials_location),
          // so checking location first would always mask this case behind a
          // generic "not at location" 422 instead of the specific "not in
          // stock" 409 the contract names.
          if (locked.status === 'ISSUED') throw new ApiError(409, `Serial ${locked.serialNumber} is not in stock`);
          if (locked.locationId !== location.id) {
            throw new ApiError(422, `Serial ${locked.serialNumber} is not at location ${location.code}`);
          }
          if (locked.status === 'ON_HOLD') throw new ApiError(409, `Serial ${locked.serialNumber} is on hold`);
          if (!canTransitionSerial(locked.status, 'ISSUED', 'MOVEMENT')) {
            throw new ApiError(409, `Serial ${locked.serialNumber} is not in stock`);
          }

          await client.query(`UPDATE stock_serials SET status = 'ISSUED', location_id = NULL WHERE id = $1 AND org_id = $2`, [
            locked.id,
            orgId,
          ]);

          const movement = await insertMovement(
            client,
            orgId,
            userId,
            movementGroupId,
            {
              movementType: 'ISSUE',
              itemId: job.item.id,
              itemCode: job.item.code,
              locationId: location.id,
              locationCode: location.code,
              lotId: null,
              lotNumber: null,
              serialId: locked.id,
              serialNumber: locked.serialNumber,
              quantityMilli: -1000,
              valueCents: -locked.costCents,
              reference: input.reference,
              reason: null,
              occurredOn: input.occurredOn,
            },
            balances,
          );
          results.push(movement);
        }
      } else {
        const key = balanceKey(job.item.id, location.id, job.lot?.id ?? null);
        const bal = balances.get(key);
        if (bal === undefined) throw new Error(`balance not locked for key ${key}`);
        if (bal.quantityMilli < job.quantityMilli) {
          throw new ApiError(409, `Insufficient stock for item ${job.item.code} at location ${location.code}`);
        }
        const value = outflowValueCents(bal.quantityMilli, bal.valueCents, job.quantityMilli);

        const movement = await insertMovement(
          client,
          orgId,
          userId,
          movementGroupId,
          {
            movementType: 'ISSUE',
            itemId: job.item.id,
            itemCode: job.item.code,
            locationId: location.id,
            locationCode: location.code,
            lotId: job.lot?.id ?? null,
            lotNumber: job.lot?.lotNumber ?? null,
            serialId: null,
            serialNumber: null,
            quantityMilli: -job.quantityMilli,
            valueCents: -value,
            reference: input.reference,
            reason: null,
            occurredOn: input.occurredOn,
          },
          balances,
        );
        results.push(movement);
      }
    }

    return results;
  });

  return { movementGroupId, movements };
}

export async function transfer(
  orgId: string,
  userId: string,
  input: {
    occurredOn: string;
    reference: string | null;
    fromLocationId: string;
    toLocationId: string;
    lines: OutboundLineInput[];
  },
): Promise<MovementResult> {
  assertNotFuture(input.occurredOn);
  if (input.fromLocationId === input.toLocationId) throw new ApiError(422, 'Transfer needs two different locations');
  const movementGroupId = randomUUID();

  const movements = await withTransaction(async (client) => {
    const fromLocation = await getLocationOnClient(client, orgId, input.fromLocationId);
    const toLocation = await assertLocationActive(client, orgId, input.toLocationId);
    const items = await loadItems(client, orgId, input.lines.map((l) => l.itemId));

    interface Job {
      item: ItemInfo;
      quantityMilli: number;
      lot: { id: string; lotNumber: string } | null;
      serialIds: string[] | null;
    }
    const jobs: Job[] = [];
    const balanceKeys: { itemId: string; locationId: string; lotId: string | null }[] = [];
    const serialIdsToLock: string[] = [];

    for (const line of input.lines) {
      const item = items.get(line.itemId);
      if (item === undefined) throw new ApiError(422, 'Item does not exist in this organization');

      if (item.tracking === 'LOT') {
        if (line.serialIds !== null) throw new ApiError(422, `Item ${item.code} is not serial-tracked`);
        if (line.lotId === null) throw new ApiError(422, `Lot-tracked item ${item.code} needs a lot`);
        assertQuantityPrecision(item, line.quantityMilli);

        const lot = await resolveExistingLot(client, orgId, item.id, line.lotId);
        jobs.push({ item, quantityMilli: line.quantityMilli, lot, serialIds: null });
        balanceKeys.push({ itemId: item.id, locationId: fromLocation.id, lotId: lot.id });
        balanceKeys.push({ itemId: item.id, locationId: toLocation.id, lotId: lot.id });
      } else if (item.tracking === 'SERIAL') {
        if (line.lotId !== null) throw new ApiError(422, `Item ${item.code} is not lot-tracked`);
        const ids = line.serialIds ?? [];
        if (ids.length * 1000 !== line.quantityMilli) {
          throw new ApiError(422, `Serial-tracked item ${item.code} needs one serial per unit`);
        }
        jobs.push({ item, quantityMilli: line.quantityMilli, lot: null, serialIds: ids });
        balanceKeys.push({ itemId: item.id, locationId: fromLocation.id, lotId: null });
        balanceKeys.push({ itemId: item.id, locationId: toLocation.id, lotId: null });
        serialIdsToLock.push(...ids);
      } else {
        if (line.lotId !== null) throw new ApiError(422, `Item ${item.code} is not lot-tracked`);
        if (line.serialIds !== null) throw new ApiError(422, `Item ${item.code} is not serial-tracked`);
        assertQuantityPrecision(item, line.quantityMilli);

        jobs.push({ item, quantityMilli: line.quantityMilli, lot: null, serialIds: null });
        balanceKeys.push({ itemId: item.id, locationId: fromLocation.id, lotId: null });
        balanceKeys.push({ itemId: item.id, locationId: toLocation.id, lotId: null });
      }
    }

    const balances = await lockBalances(client, orgId, balanceKeys);
    const serials = await lockSerials(client, orgId, serialIdsToLock);

    const results: StockMovement[] = [];
    for (const job of jobs) {
      if (job.serialIds !== null) {
        for (const serialId of job.serialIds) {
          const locked = serials.get(serialId);
          if (locked === undefined || locked.itemId !== job.item.id) {
            throw new ApiError(422, 'Serial does not exist for this item');
          }
          if (locked.status === 'ISSUED') throw new ApiError(409, `Serial ${locked.serialNumber} is not in stock`);
          if (locked.locationId !== fromLocation.id) {
            throw new ApiError(422, `Serial ${locked.serialNumber} is not at location ${fromLocation.code}`);
          }
          if (locked.status === 'ON_HOLD') throw new ApiError(409, `Serial ${locked.serialNumber} is on hold`);

          await client.query('UPDATE stock_serials SET location_id = $3 WHERE id = $1 AND org_id = $2', [
            locked.id,
            orgId,
            toLocation.id,
          ]);

          const outMovement = await insertMovement(
            client,
            orgId,
            userId,
            movementGroupId,
            {
              movementType: 'TRANSFER_OUT',
              itemId: job.item.id,
              itemCode: job.item.code,
              locationId: fromLocation.id,
              locationCode: fromLocation.code,
              lotId: null,
              lotNumber: null,
              serialId: locked.id,
              serialNumber: locked.serialNumber,
              quantityMilli: -1000,
              valueCents: -locked.costCents,
              reference: input.reference,
              reason: null,
              occurredOn: input.occurredOn,
            },
            balances,
          );
          results.push(outMovement);

          const inMovement = await insertMovement(
            client,
            orgId,
            userId,
            movementGroupId,
            {
              movementType: 'TRANSFER_IN',
              itemId: job.item.id,
              itemCode: job.item.code,
              locationId: toLocation.id,
              locationCode: toLocation.code,
              lotId: null,
              lotNumber: null,
              serialId: locked.id,
              serialNumber: locked.serialNumber,
              quantityMilli: 1000,
              valueCents: locked.costCents,
              reference: input.reference,
              reason: null,
              occurredOn: input.occurredOn,
            },
            balances,
          );
          results.push(inMovement);
        }
      } else {
        const fromKey = balanceKey(job.item.id, fromLocation.id, job.lot?.id ?? null);
        const fromBal = balances.get(fromKey);
        if (fromBal === undefined) throw new Error(`balance not locked for key ${fromKey}`);
        if (fromBal.quantityMilli < job.quantityMilli) {
          throw new ApiError(409, `Insufficient stock for item ${job.item.code} at location ${fromLocation.code}`);
        }
        const value = outflowValueCents(fromBal.quantityMilli, fromBal.valueCents, job.quantityMilli);

        const outMovement = await insertMovement(
          client,
          orgId,
          userId,
          movementGroupId,
          {
            movementType: 'TRANSFER_OUT',
            itemId: job.item.id,
            itemCode: job.item.code,
            locationId: fromLocation.id,
            locationCode: fromLocation.code,
            lotId: job.lot?.id ?? null,
            lotNumber: job.lot?.lotNumber ?? null,
            serialId: null,
            serialNumber: null,
            quantityMilli: -job.quantityMilli,
            valueCents: -value,
            reference: input.reference,
            reason: null,
            occurredOn: input.occurredOn,
          },
          balances,
        );
        results.push(outMovement);

        const inMovement = await insertMovement(
          client,
          orgId,
          userId,
          movementGroupId,
          {
            movementType: 'TRANSFER_IN',
            itemId: job.item.id,
            itemCode: job.item.code,
            locationId: toLocation.id,
            locationCode: toLocation.code,
            lotId: job.lot?.id ?? null,
            lotNumber: job.lot?.lotNumber ?? null,
            serialId: null,
            serialNumber: null,
            quantityMilli: job.quantityMilli,
            valueCents: value,
            reference: input.reference,
            reason: null,
            occurredOn: input.occurredOn,
          },
          balances,
        );
        results.push(inMovement);
      }
    }

    return results;
  });

  return { movementGroupId, movements };
}

export async function adjust(
  orgId: string,
  userId: string,
  input: { occurredOn: string; reason: string; locationId: string; lines: AdjustmentLineInput[] },
): Promise<MovementResult> {
  assertNotFuture(input.occurredOn);
  const movementGroupId = randomUUID();

  const movements = await withTransaction(async (client) => {
    const location = await getLocationOnClient(client, orgId, input.locationId);
    const items = await loadItems(client, orgId, input.lines.map((l) => l.itemId));

    interface Job {
      item: ItemInfo;
      direction: 'IN' | 'OUT';
      quantityMilli: number;
      lot: { id: string; lotNumber: string } | null;
      unitCostCents: number | null;
    }
    const jobs: Job[] = [];
    const balanceKeys: { itemId: string; locationId: string; lotId: string | null }[] = [];

    for (const line of input.lines) {
      const item = items.get(line.itemId);
      if (item === undefined) throw new ApiError(422, 'Item does not exist in this organization');
      if (item.tracking === 'SERIAL') {
        throw new ApiError(422, 'Adjust serial-tracked items with a receipt or an issue');
      }

      if (line.direction === 'IN') {
        if (!location.isActive) throw new ApiError(422, 'Location is inactive');
        if (!item.isActive) throw new ApiError(422, `Item ${item.code} is inactive`);
      }

      assertQuantityPrecision(item, line.quantityMilli);

      let lot: { id: string; lotNumber: string } | null = null;
      if (item.tracking === 'LOT') {
        if (line.lotId === null) throw new ApiError(422, `Lot-tracked item ${item.code} needs a lot`);
        lot = await resolveExistingLot(client, orgId, item.id, line.lotId);
      } else if (line.lotId !== null) {
        throw new ApiError(422, `Item ${item.code} is not lot-tracked`);
      }

      jobs.push({ item, direction: line.direction, quantityMilli: line.quantityMilli, lot, unitCostCents: line.unitCostCents });
      balanceKeys.push({ itemId: item.id, locationId: location.id, lotId: lot?.id ?? null });
    }

    const balances = await lockBalances(client, orgId, balanceKeys);

    const results: StockMovement[] = [];
    for (const job of jobs) {
      const key = balanceKey(job.item.id, location.id, job.lot?.id ?? null);
      const bal = balances.get(key);
      if (bal === undefined) throw new Error(`balance not locked for key ${key}`);

      if (job.direction === 'OUT') {
        if (bal.quantityMilli < job.quantityMilli) {
          throw new ApiError(409, `Insufficient stock for item ${job.item.code} at location ${location.code}`);
        }
        const value = outflowValueCents(bal.quantityMilli, bal.valueCents, job.quantityMilli);

        const movement = await insertMovement(
          client,
          orgId,
          userId,
          movementGroupId,
          {
            movementType: 'ADJUSTMENT_OUT',
            itemId: job.item.id,
            itemCode: job.item.code,
            locationId: location.id,
            locationCode: location.code,
            lotId: job.lot?.id ?? null,
            lotNumber: job.lot?.lotNumber ?? null,
            serialId: null,
            serialNumber: null,
            quantityMilli: -job.quantityMilli,
            valueCents: -value,
            reference: null,
            reason: input.reason,
            occurredOn: input.occurredOn,
          },
          balances,
        );
        results.push(movement);
      } else {
        let value: number;
        if (job.unitCostCents !== null) {
          value = receiptValueCents(job.unitCostCents, job.quantityMilli);
        } else if (bal.quantityMilli > 0) {
          value = scaleCents(cents(bal.valueCents), job.quantityMilli, bal.quantityMilli);
        } else {
          throw new ApiError(422, `unitCostCents is required when location ${location.code} holds none of item ${job.item.code}`);
        }

        const movement = await insertMovement(
          client,
          orgId,
          userId,
          movementGroupId,
          {
            movementType: 'ADJUSTMENT_IN',
            itemId: job.item.id,
            itemCode: job.item.code,
            locationId: location.id,
            locationCode: location.code,
            lotId: job.lot?.id ?? null,
            lotNumber: job.lot?.lotNumber ?? null,
            serialId: null,
            serialNumber: null,
            quantityMilli: job.quantityMilli,
            valueCents: value,
            reference: null,
            reason: input.reason,
            occurredOn: input.occurredOn,
          },
          balances,
        );
        results.push(movement);
      }
    }

    return results;
  });

  return { movementGroupId, movements };
}
