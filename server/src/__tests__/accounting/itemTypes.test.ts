import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 32 — Products & Services item types (SERVICE / NON_INVENTORY /
 * INVENTORY / FIXED_ASSET), the kind<->type CHECK, the stock-account CHECK and
 * cross-tenant account refusal. Integration tier, real PostgreSQL.
 */

const app = createApp();
const ITEMS = '/api/v1/items';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [orgId, code]);
  return rows[0]?.id as string;
}

async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
  }
  return undefined;
}

describe('creating items by type', () => {
  it('creates a SERVICE and a NON_INVENTORY item with itemType', async () => {
    const agent = await loginAgent(app, userA);
    const service = await agent.post(ITEMS).send({ code: 'SVC', name: 'Consulting', itemType: 'SERVICE' });
    const goods = await agent.post(ITEMS).send({ code: 'OFF', name: 'Office supplies', itemType: 'NON_INVENTORY' });

    expect(service.status).toBe(201);
    expect(service.body.item).toMatchObject({ itemType: 'SERVICE', kind: 'SERVICE', stockManaged: false });
    expect(goods.status).toBe(201);
    expect(goods.body.item).toMatchObject({ itemType: 'NON_INVENTORY', kind: 'GOODS', stockManaged: false });
  });

  it('still accepts the Phase 24 `kind` (GOODS maps to NON_INVENTORY)', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(ITEMS).send({ code: 'OLD', name: 'Old style', kind: 'GOODS' });
    expect(res.status).toBe(201);
    expect(res.body.item.itemType).toBe('NON_INVENTORY');
  });

  it('rejects a body whose kind and itemType disagree, or that names neither', async () => {
    const agent = await loginAgent(app, userA);
    expect((await agent.post(ITEMS).send({ code: 'X1', name: 'X', kind: 'SERVICE', itemType: 'NON_INVENTORY' })).status).toBe(400);
    expect((await agent.post(ITEMS).send({ code: 'X2', name: 'X' })).status).toBe(400);
  });

  it('refuses to create INVENTORY or FIXED_ASSET items — those come from Inventory', async () => {
    const agent = await loginAgent(app, userA);
    expect((await agent.post(ITEMS).send({ code: 'I', name: 'I', itemType: 'INVENTORY' })).status).toBe(422);
    expect((await agent.post(ITEMS).send({ code: 'F', name: 'F', itemType: 'FIXED_ASSET' })).status).toBe(422);
  });

  it('filters the list by itemType', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(ITEMS).send({ code: 'SVC', name: 'Consulting', itemType: 'SERVICE' });
    await agent.post(ITEMS).send({ code: 'OFF', name: 'Office supplies', itemType: 'NON_INVENTORY' });
    const res = await agent.get(`${ITEMS}?itemType=SERVICE`);
    expect(res.body.items.map((i: { code: string }) => i.code)).toEqual(['SVC']);
  });

  it('itemType is frozen, and stock accounts cannot be set on a non-stock item', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(ITEMS).send({ code: 'SVC', name: 'Consulting', itemType: 'SERVICE' });
    const id = created.body.item.id as string;

    const stripped = await agent.patch(`${ITEMS}/${id}`).send({ itemType: 'INVENTORY' });
    expect(stripped.status).toBe(400); // unknown key stripped -> "No fields to update"

    const res = await agent.patch(`${ITEMS}/${id}`).send({ assetAccountId: await accountId(orgA, '1140') });
    expect(res.status).toBe(422);
  });
});

describe('items CHECK and FK constraints (Phase 32)', () => {
  it('kind must match item_type', async () => {
    const code = await pgCode(() =>
      pool.query(
        `INSERT INTO items (org_id, created_by, code, name, kind, item_type) VALUES ($1, $2, 'X', 'X', 'SERVICE', 'INVENTORY')`,
        [orgA, userA.id],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('item_type must be one of the four types', async () => {
    const code = await pgCode(() =>
      pool.query(`INSERT INTO items (org_id, created_by, code, name, kind, item_type) VALUES ($1, $2, 'X', 'X', 'GOODS', 'BOGUS')`, [
        orgA,
        userA.id,
      ]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('asset/COGS accounts are only allowed on INVENTORY or FIXED_ASSET items', async () => {
    const code = await pgCode(async () =>
      pool.query(
        `INSERT INTO items (org_id, created_by, code, name, kind, item_type, asset_account_id)
         VALUES ($1, $2, 'X', 'X', 'GOODS', 'NON_INVENTORY', $3)`,
        [orgA, userA.id, await accountId(orgA, '1140')],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("an inventory account from another organization is rejected by the composite FK", async () => {
    const code = await pgCode(async () =>
      pool.query(
        `INSERT INTO items (org_id, created_by, code, name, kind, item_type, asset_account_id)
         VALUES ($1, $2, 'X', 'X', 'GOODS', 'INVENTORY', $3)`,
        [orgA, userA.id, await accountId(orgB, '1140')],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('the migration backfill mapping: existing SERVICE rows are SERVICE, GOODS rows NON_INVENTORY', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM items WHERE (kind = 'SERVICE') <> (item_type = 'SERVICE')`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('cross-tenant isolation (rule 15)', () => {
  it("org B cannot read, patch or filter into org A's items", async () => {
    const agentA = await loginAgent(app, userA);
    const created = await agentA.post(ITEMS).send({ code: 'SVC', name: 'Consulting', itemType: 'SERVICE' });
    const id = created.body.item.id as string;

    const agentB = await loginAgent(app, userB);
    expect((await agentB.get(`${ITEMS}/${id}`)).status).toBe(404);
    expect((await agentB.patch(`${ITEMS}/${id}`).send({ name: 'Hijacked' })).status).toBe(404);
    expect((await agentB.get(`${ITEMS}?itemType=SERVICE`)).body.items).toEqual([]);

    const untouched = await agentA.get(`${ITEMS}/${id}`);
    expect(untouched.body.item.name).toBe('Consulting');
  });

  it("org B cannot attach org A's revenue account to its own item", async () => {
    const agentB = await loginAgent(app, userB);
    const res = await agentB
      .post(ITEMS)
      .send({ code: 'X', name: 'X', itemType: 'SERVICE', revenueAccountId: await accountId(orgA, '4100') });
    expect(res.status).toBe(422);
  });
});
