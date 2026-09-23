import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — mirrors
 * `ledger-core/ledgerConstraints.test.ts`'s posture. Every test here goes
 * around `movementService` straight at the pool, proving migration 067's
 * triggers and CHECK/FK/UNIQUE constraints hold even against a hand-typed
 * statement, a data-fix script, or a future module.
 */

const FEATURE_NOT_SUPPORTED = '0A000';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return typeof err.code === 'string' ? err.code : undefined;
    }
  }
  return undefined;
}

const app = createApp();
const SETUP = '/api/v1/stock/setup';
const ITEMS = '/api/v1/stock/items';
const RECEIPTS = '/api/v1/stock/receipts';

async function categoryIdByCode(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM stock_categories WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no category ${code} in org ${orgId}`);
  return row.id;
}

async function locationIdByCode(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM stock_locations WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no location ${code} in org ${orgId}`);
  return row.id;
}

let userA: SeededUser;
let orgA: string;
let itemId: string;
let locationId: string;
let movementId: string;
let balanceId: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;
  const agentA = await loginAgent(app, userA);

  await agentA.post(SETUP).send({ industryProfile: 'MANUFACTURING' });
  const cmpCategoryId = await categoryIdByCode(orgA, 'CMP');
  const itemRes = await agentA.post(ITEMS).send({ name: 'Bolt', categoryId: cmpCategoryId, attributes: { part_number: 'B1' } });
  itemId = itemRes.body.item.id as string;
  locationId = await locationIdByCode(orgA, 'MAIN');

  const receiptRes = await agentA.post(RECEIPTS).send({
    occurredOn: '2026-06-01',
    reference: null,
    locationId,
    lines: [{ itemId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null }],
  });
  movementId = receiptRes.body.movements[0].id as string;

  const balRow = await pool.query<{ id: string }>(
    'SELECT id FROM stock_balances WHERE org_id = $1 AND item_id = $2 AND location_id = $3',
    [orgA, itemId, locationId],
  );
  const row = balRow.rows[0];
  if (row === undefined) throw new Error('fixture: no balance row');
  balanceId = row.id;
});

afterAll(closePool);

describe('stock_movements immutability', () => {
  it('UPDATE on stock_movements is refused', async () => {
    const code = await errorCode(() => pool.query('UPDATE stock_movements SET reference = $1 WHERE id = $2', ['hack', movementId]));
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('DELETE on stock_movements is refused', async () => {
    const code = await errorCode(() => pool.query('DELETE FROM stock_movements WHERE id = $1', [movementId]));
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });
});

describe('stock_balances CHECK constraints', () => {
  it('negative balance refused by CHECK', async () => {
    const code = await errorCode(() => pool.query('UPDATE stock_balances SET quantity_milli = -1 WHERE id = $1', [balanceId]));
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('zero quantity with value refused', async () => {
    const code = await errorCode(() =>
      pool.query('UPDATE stock_balances SET quantity_milli = 0, value_cents = 100 WHERE id = $1', [balanceId]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a second NULL-lot balance row for the same item/location is refused', async () => {
    const code = await errorCode(() =>
      pool.query('INSERT INTO stock_balances (org_id, item_id, location_id, lot_id) VALUES ($1, $2, $3, NULL)', [
        orgA,
        itemId,
        locationId,
      ]),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });
});

describe('stock_movements CHECK and FK constraints', () => {
  it('outbound movement with positive quantity refused by ck_stock_movements_sign', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO stock_movements
           (org_id, movement_group_id, movement_type, item_id, location_id, quantity_milli, value_cents, occurred_on, created_by)
         VALUES ($1, gen_random_uuid(), 'ISSUE', $2, $3, 1000, -1000, '2026-06-01', $4)`,
        [orgA, itemId, locationId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('a movement cannot reference another org item', async () => {
    const userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    const agentB = await loginAgent(app, userB);
    await agentB.post(SETUP).send({ industryProfile: 'MANUFACTURING' });
    const cmpCategoryIdB = await categoryIdByCode(userB.orgId, 'CMP');
    const itemResB = await agentB
      .post(ITEMS)
      .send({ name: 'Foreign bolt', categoryId: cmpCategoryIdB, attributes: { part_number: 'FB' } });
    const foreignItemId = itemResB.body.item.id as string;

    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO stock_movements
           (org_id, movement_group_id, movement_type, item_id, location_id, quantity_milli, value_cents, occurred_on, created_by)
         VALUES ($1, gen_random_uuid(), 'RECEIPT', $2, $3, 1000, 1000, '2026-06-01', $4)`,
        [orgA, foreignItemId, locationId, userA.id],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('stock_serials CHECK constraint', () => {
  it('serial ISSUED with a location refused', async () => {
    const code = await errorCode(() =>
      pool.query(
        `INSERT INTO stock_serials (org_id, item_id, serial_number, status, location_id, cost_cents, created_by)
         VALUES ($1, $2, 'BADSN', 'ISSUED', $3, 1000, $4)`,
        [orgA, itemId, locationId, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});
