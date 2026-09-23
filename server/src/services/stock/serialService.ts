import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { validateAttributes } from '../../utils/stockAttributes.js';
import { getActiveDefinitions } from './catalogueService.js';
import { canTransitionSerial } from '../../types/stock.js';
import type { StockAttributes, StockSerial, StockSerialStatus } from '../../types/stock.js';

/**
 * StockLedger (Phase 28) — manual serial status changes (the real-estate
 * booking flow: AVAILABLE ⇄ ON_HOLD ⇄ BOOKED) and per-serial custom-field
 * edits. `ISSUED` is reachable only through a movement (rule 10 — the one
 * FSM transition table lives in types/stock.ts, and every status change in
 * this codebase goes through `canTransitionSerial`).
 */

interface SerialRow {
  id: string;
  item_id: string;
  serial_number: string;
  status: string;
  location_id: string | null;
  location_code: string | null;
  cost_cents: string;
  status_note: string | null;
  attributes: StockAttributes;
  created_at: Date;
  updated_at: Date;
}

const SERIAL_SELECT = `
  SELECT s.id, s.item_id, s.serial_number, s.status, s.location_id, loc.code AS location_code,
         s.cost_cents, s.status_note, s.attributes, s.created_at, s.updated_at
    FROM stock_serials s
    LEFT JOIN stock_locations loc ON loc.id = s.location_id AND loc.org_id = s.org_id
`;

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

async function getSerial(orgId: string, id: string): Promise<StockSerial> {
  const { rows } = await pool.query<SerialRow>(`${SERIAL_SELECT} WHERE s.org_id = $1 AND s.id = $2`, [orgId, id]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Serial not found');
  return toSerial(row);
}

export async function changeSerialStatus(
  orgId: string,
  serialId: string,
  input: { status: 'AVAILABLE' | 'ON_HOLD' | 'BOOKED'; note: string | null },
): Promise<StockSerial> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM stock_serials WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [serialId, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Serial not found');

    const current = row.status as StockSerialStatus;
    if (!canTransitionSerial(current, input.status, 'MANUAL')) {
      throw new ApiError(409, `Cannot move serial from ${current} to ${input.status}`);
    }

    await client.query('UPDATE stock_serials SET status = $3, status_note = $4 WHERE id = $1 AND org_id = $2', [
      serialId,
      orgId,
      input.status,
      input.note,
    ]);
  });

  return getSerial(orgId, serialId);
}

export async function updateSerialAttributes(
  orgId: string,
  serialId: string,
  attributes: Record<string, unknown>,
): Promise<StockSerial> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ item_id: string }>(
      'SELECT item_id FROM stock_serials WHERE id = $1 AND org_id = $2',
      [serialId, orgId],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Serial not found');

    const { rows: itemRows } = await client.query<{ category_id: string }>(
      'SELECT category_id FROM stock_items WHERE id = $1 AND org_id = $2',
      [row.item_id, orgId],
    );
    const item = itemRows[0];
    if (item === undefined) throw new ApiError(404, 'Serial not found');

    const definitions = await getActiveDefinitions(client, orgId, item.category_id, 'SERIAL');
    const validated = validateAttributes(definitions, attributes);
    if (!validated.ok) throw new ApiError(422, `Invalid attributes: ${validated.errors.join('; ')}`);

    await client.query('UPDATE stock_serials SET attributes = $3::jsonb WHERE id = $1 AND org_id = $2', [
      serialId,
      orgId,
      JSON.stringify(validated.value),
    ]);
  });

  return getSerial(orgId, serialId);
}
