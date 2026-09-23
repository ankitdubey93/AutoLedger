import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';

/**
 * StockLedger (Phase 28) — the movement write path under real concurrency:
 * two simultaneous requests, proving the pessimistic balance lock and its
 * deterministic sort order (movementService.ts's `lockBalances`).
 *
 * Two separate logged-in agents are used for the two concurrent requests —
 * never one agent making two calls — because a single supertest agent
 * serializes requests over one connection, which would hide the very race
 * these tests exist to exercise.
 */

const app = createApp();
const SETUP = '/api/v1/stock/setup';
const ITEMS = '/api/v1/stock/items';
const RECEIPTS = '/api/v1/stock/receipts';
const ISSUES = '/api/v1/stock/issues';
const BALANCES = '/api/v1/stock/balances';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function switchTo(agent: Agent, targetOrgId: string): Promise<Agent> {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

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

interface Fixture {
  orgA: string;
  agentA: Agent;
  agentA2: Agent;
  mainA: string;
  xId: string;
  yId: string;
}

/** Two members of the same org, so two independent, simultaneously-usable agents exist for it. */
async function buildFixture(): Promise<Fixture> {
  const userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const userA2 = await createUserWithOrg({ label: 'alice2', orgName: 'Org Alpha2 Solo' });
  await addMember(userA.orgId, userA2.id, 'OWNER');

  const agentA = await loginAgent(app, userA);
  const agentA2 = await loginAgent(app, userA2);
  await switchTo(agentA2, userA.orgId);

  await agentA.post(SETUP).send({ industryProfile: 'MANUFACTURING' });
  const mainA = await locationIdByCode(userA.orgId, 'MAIN');
  const cmpCategoryId = await categoryIdByCode(userA.orgId, 'CMP');

  const xRes = await agentA.post(ITEMS).send({ name: 'Item X', categoryId: cmpCategoryId, attributes: { part_number: 'X' } });
  const yRes = await agentA.post(ITEMS).send({ name: 'Item Y', categoryId: cmpCategoryId, attributes: { part_number: 'Y' } });

  return {
    orgA: userA.orgId,
    agentA,
    agentA2,
    mainA,
    xId: xRes.body.item.id as string,
    yId: yRes.body.item.id as string,
  };
}

afterAll(closePool);

describe('movement concurrency', () => {
  it('two concurrent issues of the last unit: exactly one succeeds', async () => {
    await resetTables();
    const f = await buildFixture();

    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.xId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null }],
    });

    const [r1, r2] = await Promise.all([
      f.agentA.post(ISSUES).send({
        occurredOn: '2026-06-01',
        reference: null,
        locationId: f.mainA,
        lines: [{ itemId: f.xId, quantityMilli: 1000, lotId: null, serialIds: null }],
      }),
      f.agentA2.post(ISSUES).send({
        occurredOn: '2026-06-01',
        reference: null,
        locationId: f.mainA,
        lines: [{ itemId: f.xId, quantityMilli: 1000, lotId: null, serialIds: null }],
      }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const bal = await f.agentA.get(`${BALANCES}?itemId=${f.xId}&includeZero=true`);
    expect(bal.body.balances[0].quantityMilli).toBe(0);
  });

  it('two concurrent multi-line issues in opposite line order do not deadlock', async () => {
    await resetTables();
    const f = await buildFixture();

    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.xId, quantityMilli: 10000, unitCostCents: 1000, lot: null, serials: null }],
    });
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.yId, quantityMilli: 10000, unitCostCents: 1000, lot: null, serials: null }],
    });

    const [r1, r2] = await Promise.all([
      f.agentA.post(ISSUES).send({
        occurredOn: '2026-06-01',
        reference: null,
        locationId: f.mainA,
        lines: [
          { itemId: f.xId, quantityMilli: 1000, lotId: null, serialIds: null },
          { itemId: f.yId, quantityMilli: 1000, lotId: null, serialIds: null },
        ],
      }),
      f.agentA2.post(ISSUES).send({
        occurredOn: '2026-06-01',
        reference: null,
        locationId: f.mainA,
        lines: [
          { itemId: f.yId, quantityMilli: 1000, lotId: null, serialIds: null },
          { itemId: f.xId, quantityMilli: 1000, lotId: null, serialIds: null },
        ],
      }),
    ]);

    expect(r1.status, `r1 body: ${JSON.stringify(r1.body)}`).toBe(201);
    expect(r2.status, `r2 body: ${JSON.stringify(r2.body)}`).toBe(201);

    const balX = await f.agentA.get(`${BALANCES}?itemId=${f.xId}`);
    const balY = await f.agentA.get(`${BALANCES}?itemId=${f.yId}`);
    expect(balX.body.balances[0].quantityMilli).toBe(8000);
    expect(balY.body.balances[0].quantityMilli).toBe(8000);
  });
});
