import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — items (Phase 24). Integration tier, real PostgreSQL.
 *
 * Includes this app's own cross-tenant isolation suite (rule 15). Fixture
 * mirrors customers.test.ts's shape.
 */

const app = createApp();
const BASE = '/api/v1/items';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

describe('POST /items', () => {
  it('creates a service item', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccount = await accountId(orgA, '4100');

    const res = await agent.post(BASE).send({
      code: 'CONSULT',
      name: 'Consulting hour',
      kind: 'SERVICE',
      salePriceCents: 15000,
      revenueAccountId: revenueAccount,
    });

    expect(res.status).toBe(201);
    expect(res.body.item.kind).toBe('SERVICE');
    expect(res.body.item.salePriceCents).toBe(15000);
  });

  it('rejects a duplicate code', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(BASE).send({ code: 'CONSULT', name: 'Consulting hour', kind: 'SERVICE' });

    const res = await agent.post(BASE).send({ code: 'CONSULT', name: 'Consulting again', kind: 'SERVICE' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Item code already exists');
  });

  it('rejects a non-Revenue revenue account', async () => {
    const agent = await loginAgent(app, userA);
    const expenseAccount = await accountId(orgA, '6100');

    const res = await agent.post(BASE).send({
      code: 'CONSULT',
      name: 'Consulting hour',
      kind: 'SERVICE',
      revenueAccountId: expenseAccount,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Item revenue account must be a Revenue account');
  });

  it('rejects a non-postable revenue account', async () => {
    const agent = await loginAgent(app, userA);
    const headerAccount = await accountId(orgA, '4000');

    const res = await agent.post(BASE).send({
      code: 'CONSULT',
      name: 'Consulting hour',
      kind: 'SERVICE',
      revenueAccountId: headerAccount,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Item revenue account must be postable');
  });

  it('an item cannot reference another organization account', async () => {
    const agent = await loginAgent(app, userA);
    const orgBRevenueAccount = await accountId(orgB, '4100');

    const res = await agent.post(BASE).send({
      code: 'CONSULT',
      name: 'Consulting hour',
      kind: 'SERVICE',
      revenueAccountId: orgBRevenueAccount,
    });

    expect(res.status).toBe(422);
  });
});

describe('PATCH /items/:id', () => {
  it('cannot change code or kind', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(BASE).send({ code: 'CONSULT', name: 'Consulting hour', kind: 'SERVICE' });

    const res = await agent.patch(`${BASE}/${created.body.item.id}`).send({ code: 'X' });

    expect(res.status).toBe(400);
  });

  it('deactivates', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(BASE).send({ code: 'CONSULT', name: 'Consulting hour', kind: 'SERVICE' });

    const res = await agent.patch(`${BASE}/${created.body.item.id}`).send({ isActive: false });
    expect(res.status).toBe(200);

    const defaultList = await agent.get(BASE);
    expect(defaultList.body.items).toHaveLength(0);

    const withInactive = await agent.get(`${BASE}?includeInactive=true`);
    expect(withInactive.body.items).toHaveLength(1);
  });
});

describe('GET /items', () => {
  it('?kind=GOODS filters', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(BASE).send({ code: 'CONSULT', name: 'Consulting hour', kind: 'SERVICE' });
    await agent.post(BASE).send({ code: 'WIDGET', name: 'Widget', kind: 'GOODS' });

    const res = await agent.get(`${BASE}?kind=GOODS`);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].code).toBe('WIDGET');
  });

  it('there is no DELETE /items/:id', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(BASE).send({ code: 'CONSULT', name: 'Consulting hour', kind: 'SERVICE' });

    const res = await agent.delete(`${BASE}/${created.body.item.id}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('cross-tenant isolation on a single item', () => {
  it('org A cannot read or patch an org B item', async () => {
    const agentC = await loginAgent(app, userC);
    const created = await agentC.post(BASE).send({ code: 'WIDGET', name: 'Widget', kind: 'GOODS' });
    const itemId = created.body.item.id as string;

    const agentA = await loginAgent(app, userA);
    const getRes = await agentA.get(`${BASE}/${itemId}`);
    expect(getRes.status).toBe(404);

    const patchRes = await agentA.patch(`${BASE}/${itemId}`).send({ isActive: false });
    expect(patchRes.status).toBe(404);

    const listRes = await agentA.get(BASE);
    expect((listRes.body.items as { code: string }[]).some((i) => i.code === 'WIDGET')).toBe(false);

    const readBack = await agentC.get(`${BASE}/${itemId}`);
    expect(readBack.body.item.isActive).toBe(true);
    expect(orgB).not.toBe(orgA);
  });
});
