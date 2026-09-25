import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Inventory (Phase 28) — the movement write path: receipts, issues,
 * transfers, adjustments. Integration tier, real PostgreSQL. Includes this
 * module's cross-tenant isolation and rollback suites (rules 15, 5).
 */

const app = createApp();
const SETUP = '/api/v1/inventory/setup';
const CATEGORIES = '/api/v1/inventory/categories';
const LOCATIONS = '/api/v1/inventory/locations';
const ITEMS = '/api/v1/inventory/items';
const RECEIPTS = '/api/v1/inventory/receipts';
const ISSUES = '/api/v1/inventory/issues';
const TRANSFERS = '/api/v1/inventory/transfers';
const ADJUSTMENTS = '/api/v1/inventory/adjustments';
const BALANCES = '/api/v1/inventory/balances';
const MOVEMENTS = '/api/v1/inventory/movements';
const SUMMARY = '/api/v1/inventory/summary';

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

async function uomIdByCode(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM stock_uoms WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no uom ${code} in org ${orgId}`);
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
  userA: SeededUser;
  userB: SeededUser;
  orgA: string;
  orgB: string;
  agentA: Agent;
  agentB: Agent;
  mainA: string;
  wh2A: string;
  mainB: string;
  rmItemId: string;
  rmItemCode: string;
  cmpItemId: string;
  cmpItemCode: string;
  devItemId: string;
  devItemCode: string;
  cmpItemIdB: string;
}

/**
 * Applies MANUFACTURING to both org A and org B, adds a second warehouse
 * and a serial-tracked DEV category/item to org A, and one minimal item to
 * org B for isolation assertions.
 */
async function buildFixture(): Promise<Fixture> {
  const userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  const orgA = userA.orgId;
  const orgB = userB.orgId;
  const agentA = await loginAgent(app, userA);
  const agentB = await loginAgent(app, userB);

  await agentA.post(SETUP).send({ industryProfile: 'MANUFACTURING' });
  await agentB.post(SETUP).send({ industryProfile: 'MANUFACTURING' });

  const mainA = await locationIdByCode(orgA, 'MAIN');
  const wh2Res = await agentA.post(LOCATIONS).send({ code: 'WH2', name: 'Warehouse 2', kind: 'WAREHOUSE' });
  const wh2A = wh2Res.body.location.id as string;
  const mainB = await locationIdByCode(orgB, 'MAIN');

  const rmCategoryId = await categoryIdByCode(orgA, 'RM');
  const cmpCategoryId = await categoryIdByCode(orgA, 'CMP');
  const eaUomId = await uomIdByCode(orgA, 'EA');

  const devCategoryRes = await agentA.post(CATEGORIES).send({
    code: 'DEV',
    name: 'Devices',
    itemType: 'TRADING_GOOD',
    defaultTracking: 'SERIAL',
    defaultUomId: eaUomId,
  });
  const devCategoryId = devCategoryRes.body.category.id as string;
  await agentA
    .post(`${CATEGORIES}/${devCategoryId}/attributes`)
    .send({ key: 'imei', label: 'IMEI', appliesTo: 'SERIAL', dataType: 'TEXT' });

  const rmRes = await agentA.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmCategoryId, attributes: { grade: 'SS304' } });
  const cmpRes = await agentA.post(ITEMS).send({ name: 'Bolt', categoryId: cmpCategoryId, attributes: { part_number: 'B1' } });
  const devRes = await agentA.post(ITEMS).send({ name: 'Sensor', categoryId: devCategoryId, attributes: {} });

  const cmpCategoryIdB = await categoryIdByCode(orgB, 'CMP');
  const cmpResB = await agentB
    .post(ITEMS)
    .send({ name: 'Foreign bolt', categoryId: cmpCategoryIdB, attributes: { part_number: 'FB1' } });

  return {
    userA,
    userB,
    orgA,
    orgB,
    agentA,
    agentB,
    mainA,
    wh2A,
    mainB,
    rmItemId: rmRes.body.item.id as string,
    rmItemCode: rmRes.body.item.code as string,
    cmpItemId: cmpRes.body.item.id as string,
    cmpItemCode: cmpRes.body.item.code as string,
    devItemId: devRes.body.item.id as string,
    devItemCode: devRes.body.item.code as string,
    cmpItemIdB: cmpResB.body.item.id as string,
  };
}

let f: Fixture;

beforeEach(async () => {
  await resetTables();
  f = await buildFixture();
});

afterAll(closePool);

describe('receipts and issues (moving average)', () => {
  it('receipt then partial issue uses moving average', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 3000, unitCostCents: 1000, lot: null, serials: null }],
    });
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1600, lot: null, serials: null }],
    });

    const before = await f.agentA.get(`${BALANCES}?itemId=${f.cmpItemId}`);
    expect(before.body.balances[0].quantityMilli).toBe(4000);
    expect(before.body.balances[0].valueCents).toBe(4600);

    const issued = await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, lotId: null, serialIds: null }],
    });
    expect(issued.status).toBe(201);
    expect(issued.body.movements[0].valueCents).toBe(-1150);

    const after = await f.agentA.get(`${BALANCES}?itemId=${f.cmpItemId}`);
    expect(after.body.balances[0].quantityMilli).toBe(3000);
    expect(after.body.balances[0].valueCents).toBe(3450);
    expect(after.body.balances[0].averageUnitCostCents).toBe(1150);
  });

  it('issuing everything takes the whole value', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 3000, unitCostCents: 1000, lot: null, serials: null }],
    });
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1600, lot: null, serials: null }],
    });
    await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, lotId: null, serialIds: null }],
    });

    const final = await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 3000, lotId: null, serialIds: null }],
    });
    expect(final.status).toBe(201);
    expect(final.body.movements[0].valueCents).toBe(-3450);

    const bal = await f.agentA.get(`${BALANCES}?itemId=${f.cmpItemId}&includeZero=true`);
    expect(bal.body.balances[0].quantityMilli).toBe(0);
    expect(bal.body.balances[0].valueCents).toBe(0);
  });

  it('insufficient stock → 409 exact message', async () => {
    const res = await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, lotId: null, serialIds: null }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`Insufficient stock for item ${f.cmpItemCode} at location MAIN`);
  });

  it('fractional quantity on an EA item → 422', async () => {
    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1500, unitCostCents: 100, lot: null, serials: null }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`Quantity for item ${f.cmpItemCode} allows at most 0 decimal places`);
  });

  it('future date → 422', async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: future,
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Movement date cannot be in the future');
  });

  it('inactive item cannot be received (422)', async () => {
    await f.agentA.patch(`${ITEMS}/${f.cmpItemId}`).send({ isActive: false });
    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`Item ${f.cmpItemCode} is inactive`);
  });

  it('VIEWER cannot post a receipt (403)', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(f.orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await switchTo(agent, f.orgA);

    const res = await agent.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null }],
    });
    expect(res.status).toBe(403);
  });
});

describe('lot tracking', () => {
  it('lot receipt creates the lot; issue needs lotId', async () => {
    const receipt = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.rmItemId,
          quantityMilli: 5000,
          unitCostCents: 200,
          lot: { lotNumber: 'L1', manufacturedOn: null, expiresOn: '2027-01-31' },
          serials: null,
        },
      ],
    });
    expect(receipt.status).toBe(201);
    expect(receipt.body.movements[0].lotNumber).toBe('L1');

    const issue = await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.rmItemId, quantityMilli: 1000, lotId: null, serialIds: null }],
    });
    expect(issue.status).toBe(422);
    expect(issue.body.error).toBe(`Lot-tracked item ${f.rmItemCode} needs a lot`);
  });

  it('same lot with a different expiry → 422', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.rmItemId,
          quantityMilli: 1000,
          unitCostCents: 200,
          lot: { lotNumber: 'L1', manufacturedOn: null, expiresOn: '2027-01-31' },
          serials: null,
        },
      ],
    });

    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.rmItemId,
          quantityMilli: 1000,
          unitCostCents: 200,
          lot: { lotNumber: 'L1', manufacturedOn: null, expiresOn: '2027-02-28' },
          serials: null,
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Lot L1 already exists with a different expiry date');
  });

  it('lots are listed FEFO', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.rmItemId,
          quantityMilli: 1000,
          unitCostCents: 200,
          lot: { lotNumber: 'L1', manufacturedOn: null, expiresOn: '2027-03-01' },
          serials: null,
        },
      ],
    });
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.rmItemId,
          quantityMilli: 1000,
          unitCostCents: 200,
          lot: { lotNumber: 'L2', manufacturedOn: null, expiresOn: '2027-01-15' },
          serials: null,
        },
      ],
    });

    const res = await f.agentA.get(`${ITEMS}/${f.rmItemId}/lots`);
    expect(res.status).toBe(200);
    expect(res.body.lots.map((l: { lotNumber: string }) => l.lotNumber)).toEqual(['L2', 'L1']);
  });
});

describe('serial tracking', () => {
  it('serial receipt creates serials and values each at its own cost', async () => {
    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.devItemId,
          quantityMilli: 2000,
          unitCostCents: 50000,
          lot: null,
          serials: [
            { serialNumber: 'SN1', costCents: 50000, attributes: { imei: '111111111111111' } },
            { serialNumber: 'SN2', costCents: 52000, attributes: { imei: '222222222222222' } },
          ],
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.movements).toHaveLength(2);

    const bal = await f.agentA.get(`${BALANCES}?itemId=${f.devItemId}`);
    expect(bal.body.balances[0].valueCents).toBe(102000);
  });

  it('issuing a serial takes exactly its cost (specific identification)', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.devItemId,
          quantityMilli: 2000,
          unitCostCents: 50000,
          lot: null,
          serials: [
            { serialNumber: 'SN1', costCents: 50000, attributes: { imei: '111111111111111' } },
            { serialNumber: 'SN2', costCents: 52000, attributes: { imei: '222222222222222' } },
          ],
        },
      ],
    });

    const serialsRes = await f.agentA.get(`${ITEMS}/${f.devItemId}/serials`);
    const sn2 = serialsRes.body.serials.find((s: { serialNumber: string }) => s.serialNumber === 'SN2');

    const issue = await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.devItemId, quantityMilli: 1000, lotId: null, serialIds: [sn2.id] }],
    });
    expect(issue.status).toBe(201);
    expect(issue.body.movements[0].valueCents).toBe(-52000);

    const bal = await f.agentA.get(`${BALANCES}?itemId=${f.devItemId}`);
    expect(bal.body.balances[0].valueCents).toBe(50000);

    const after = await f.agentA.get(`${ITEMS}/${f.devItemId}/serials?status=ISSUED`);
    const issuedSn2 = after.body.serials.find((s: { serialNumber: string }) => s.serialNumber === 'SN2');
    expect(issuedSn2.status).toBe('ISSUED');
    expect(issuedSn2.locationId).toBeNull();
  });

  it('serial count mismatch → 422', async () => {
    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.devItemId,
          quantityMilli: 2000,
          unitCostCents: 50000,
          lot: null,
          serials: [{ serialNumber: 'SN1', costCents: null, attributes: { imei: '111111111111111' } }],
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`Serial-tracked item ${f.devItemCode} needs one serial per unit`);
  });

  it('re-receiving an ISSUED serial returns it to AVAILABLE', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.devItemId,
          quantityMilli: 1000,
          unitCostCents: 50000,
          lot: null,
          serials: [{ serialNumber: 'SN1', costCents: null, attributes: { imei: '111111111111111' } }],
        },
      ],
    });
    const serialsRes = await f.agentA.get(`${ITEMS}/${f.devItemId}/serials`);
    const sn1 = serialsRes.body.serials[0];

    await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.devItemId, quantityMilli: 1000, lotId: null, serialIds: [sn1.id] }],
    });

    const reReceive = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.devItemId,
          quantityMilli: 1000,
          unitCostCents: 51000,
          lot: null,
          serials: [{ serialNumber: 'SN1', costCents: 51000, attributes: { imei: '111111111111111' } }],
        },
      ],
    });
    expect(reReceive.status).toBe(201);

    const after = await f.agentA.get(`${ITEMS}/${f.devItemId}/serials?status=AVAILABLE`);
    expect(after.body.serials.some((s: { serialNumber: string }) => s.serialNumber === 'SN1')).toBe(true);
  });

  it('receiving an in-stock serial → 409', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.devItemId,
          quantityMilli: 1000,
          unitCostCents: 50000,
          lot: null,
          serials: [{ serialNumber: 'SN1', costCents: null, attributes: { imei: '111111111111111' } }],
        },
      ],
    });

    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.devItemId,
          quantityMilli: 1000,
          unitCostCents: 50000,
          lot: null,
          serials: [{ serialNumber: 'SN1', costCents: null, attributes: { imei: '111111111111111' } }],
        },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Serial SN1 is already in stock');
  });
});

describe('transfers', () => {
  it('transfer moves quantity and value without re-pricing', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 3000, unitCostCents: 1000, lot: null, serials: null }],
    });

    const res = await f.agentA.post(TRANSFERS).send({
      occurredOn: '2026-06-01',
      reference: null,
      fromLocationId: f.mainA,
      toLocationId: f.wh2A,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, lotId: null, serialIds: null }],
    });
    expect(res.status).toBe(201);
    const [outMovement, inMovement] = res.body.movements;
    expect(outMovement.valueCents).toBe(-inMovement.valueCents);

    const balMain = await f.agentA.get(`${BALANCES}?itemId=${f.cmpItemId}&locationId=${f.mainA}`);
    const balWh2 = await f.agentA.get(`${BALANCES}?itemId=${f.cmpItemId}&locationId=${f.wh2A}`);
    const totalValue = balMain.body.balances[0].valueCents + balWh2.body.balances[0].valueCents;
    expect(totalValue).toBe(3000);
  });

  it('transfer to the same location → 422', async () => {
    const res = await f.agentA.post(TRANSFERS).send({
      occurredOn: '2026-06-01',
      reference: null,
      fromLocationId: f.mainA,
      toLocationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, lotId: null, serialIds: null }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Transfer needs two different locations');
  });
});

describe('adjustments', () => {
  it('adjustment IN without cost re-uses the average; on an empty location → 422 exact message', async () => {
    const empty = await f.agentA.post(ADJUSTMENTS).send({
      occurredOn: '2026-06-01',
      reason: 'count',
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, direction: 'IN', quantityMilli: 1000, lotId: null, unitCostCents: null }],
    });
    expect(empty.status).toBe(422);
    expect(empty.body.error).toBe(`unitCostCents is required when location MAIN holds none of item ${f.cmpItemCode}`);

    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 2000, unitCostCents: 1000, lot: null, serials: null }],
    });

    const adjusted = await f.agentA.post(ADJUSTMENTS).send({
      occurredOn: '2026-06-01',
      reason: 'count',
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, direction: 'IN', quantityMilli: 1000, lotId: null, unitCostCents: null }],
    });
    expect(adjusted.status).toBe(201);
    expect(adjusted.body.movements[0].valueCents).toBe(1000);
  });

  it('adjustment needs a reason (400)', async () => {
    const res = await f.agentA.post(ADJUSTMENTS).send({
      occurredOn: '2026-06-01',
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, direction: 'IN', quantityMilli: 1000, lotId: null, unitCostCents: 1000 }],
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /inventory/movements', () => {
  it('carries a running quantity across pages', async () => {
    for (const qty of [1000, 2000, 3000]) {
      await f.agentA.post(RECEIPTS).send({
        occurredOn: '2026-06-01',
        reference: null,
        locationId: f.mainA,
        lines: [{ itemId: f.cmpItemId, quantityMilli: qty, unitCostCents: 1000, lot: null, serials: null }],
      });
    }
    const res = await f.agentA.get(`${MOVEMENTS}?itemId=${f.cmpItemId}&limit=1&page=2`);
    expect(res.status).toBe(200);
    expect(res.body.movements[0].runningLocationQuantityMilli).toBe(3000);
  });
});

describe('GET /inventory/summary', () => {
  it('counts low stock and expiring lots', async () => {
    await f.agentA.patch(`${ITEMS}/${f.cmpItemId}`).send({ reorderPointMilli: 5000 });
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null }],
    });

    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        {
          itemId: f.rmItemId,
          quantityMilli: 1000,
          unitCostCents: 200,
          lot: { lotNumber: 'EXP1', manufacturedOn: null, expiresOn: soon },
          serials: null,
        },
      ],
    });

    const res = await f.agentA.get(SUMMARY);
    expect(res.status).toBe(200);
    expect(res.body.summary.lowStockItemCount).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.expiringLotCount).toBeGreaterThanOrEqual(1);
  });
});

describe('integrity', () => {
  it('passes after the whole sequence', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 3000, unitCostCents: 1000, lot: null, serials: null }],
    });
    await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, lotId: null, serialIds: null }],
    });
    await f.agentA.post(TRANSFERS).send({
      occurredOn: '2026-06-01',
      reference: null,
      fromLocationId: f.mainA,
      toLocationId: f.wh2A,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, lotId: null, serialIds: null }],
    });
    await f.agentA.post(ADJUSTMENTS).send({
      occurredOn: '2026-06-01',
      reason: 'count',
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, direction: 'OUT', quantityMilli: 500, lotId: null, unitCostCents: null }],
    });

    const report = await runIntegrityChecks();
    const check = report.checks.find((c) => c.name === 'stock_balances_match_movements');
    expect(check?.passed).toBe(true);
  });
});

describe('cross-tenant isolation', () => {
  it('receipt into org B location → 422 "Location does not exist in this organization"', async () => {
    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainB,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Location does not exist in this organization');
  });

  it('issue of org B item → 422', async () => {
    const res = await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemIdB, quantityMilli: 1000, lotId: null, serialIds: null }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Item does not exist in this organization');
  });

  it('org B cannot see org A balances or movements', async () => {
    await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [{ itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null }],
    });

    const balRes = await f.agentB.get(BALANCES);
    expect(balRes.body.balances).toEqual([]);
    const movRes = await f.agentB.get(MOVEMENTS);
    expect(movRes.body.movements).toEqual([]);
  });

  it('GET org B item lots → 404', async () => {
    const res = await f.agentA.get(`${ITEMS}/${f.cmpItemIdB}/lots`);
    expect(res.status).toBe(404);
  });
});

describe('rollback', () => {
  it('a multi-line receipt with one bad line writes nothing', async () => {
    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.mainA,
      lines: [
        { itemId: f.cmpItemId, quantityMilli: 1000, unitCostCents: 1000, lot: null, serials: null },
        { itemId: f.cmpItemId, quantityMilli: 1500, unitCostCents: 1000, lot: null, serials: null },
      ],
    });
    expect(res.status).toBe(422);

    const movCount = await pool.query<{ count: string }>('SELECT count(*) FROM stock_movements WHERE org_id = $1', [f.orgA]);
    expect(movCount.rows[0]?.count).toBe('0');
    const balCount = await pool.query<{ count: string }>('SELECT count(*) FROM stock_balances WHERE org_id = $1', [f.orgA]);
    expect(balCount.rows[0]?.count).toBe('0');
    const lotCount = await pool.query<{ count: string }>('SELECT count(*) FROM stock_lots WHERE org_id = $1', [f.orgA]);
    expect(lotCount.rows[0]?.count).toBe('0');
  });
});
