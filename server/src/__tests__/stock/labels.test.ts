import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { env } from '../../config/env.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * StockLedger (Phase 28) — QR label generation and scan-and-lookup.
 * Integration tier, real PostgreSQL. Includes this module's cross-tenant
 * isolation suite (rule 15).
 */

const app = createApp();
const SETUP = '/api/v1/stock/setup';
const CATEGORIES = '/api/v1/stock/categories';
const ITEMS = '/api/v1/stock/items';
const RECEIPTS = '/api/v1/stock/receipts';
const LABELS = '/api/v1/stock/labels';
const LOOKUP = '/api/v1/stock/lookup';

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

async function uomIdByCode(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM stock_uoms WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no uom ${code} in org ${orgId}`);
  return row.id;
}

type Agent = Awaited<ReturnType<typeof loginAgent>>;

interface Fixture {
  userA: SeededUser;
  orgA: string;
  agentA: Agent;
  mainA: string;
  cmpItemId: string;
  cmpItemCode: string;
  rmItemId: string;
  lotId: string;
  serialItemId: string;
  serialId: string;
  cmpItemIdB: string;
  serialIdB: string;
}

/** MANUFACTURING for org A: a barcoded CMP item, a lot-tracked RM item with one lot, a serial-tracked DEV item with one serial. Org B mirrors just enough for isolation checks. */
async function buildFixture(): Promise<Fixture> {
  const userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const agentA = await loginAgent(app, userA);
  await agentA.post(SETUP).send({ industryProfile: 'MANUFACTURING' });

  const mainA = await locationIdByCode(userA.orgId, 'MAIN');
  const cmpCategoryId = await categoryIdByCode(userA.orgId, 'CMP');
  const rmCategoryId = await categoryIdByCode(userA.orgId, 'RM');
  const eaUomIdA = await uomIdByCode(userA.orgId, 'EA');

  const cmpRes = await agentA
    .post(ITEMS)
    .send({ name: 'Bolt', categoryId: cmpCategoryId, attributes: { part_number: 'B1' }, barcode: '4006381333931' });
  const cmpItemId = cmpRes.body.item.id as string;
  const cmpItemCode = cmpRes.body.item.code as string;

  const rmRes = await agentA.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmCategoryId, attributes: { grade: 'SS304' } });
  const rmItemId = rmRes.body.item.id as string;
  await agentA.post(RECEIPTS).send({
    occurredOn: '2026-06-01',
    reference: null,
    locationId: mainA,
    lines: [
      {
        itemId: rmItemId,
        quantityMilli: 1000,
        unitCostCents: 200,
        lot: { lotNumber: 'L1', manufacturedOn: null, expiresOn: '2027-01-31' },
        serials: null,
      },
    ],
  });
  const lotsRes = await agentA.get(`${ITEMS}/${rmItemId}/lots`);
  const lotId = lotsRes.body.lots[0].id as string;

  const devCategoryRes = await agentA.post(CATEGORIES).send({
    code: 'DEV',
    name: 'Devices',
    itemType: 'TRADING_GOOD',
    defaultTracking: 'SERIAL',
    defaultUomId: eaUomIdA,
  });
  const devCategoryId = devCategoryRes.body.category.id as string;
  const devRes = await agentA.post(ITEMS).send({ name: 'Sensor', categoryId: devCategoryId, attributes: {} });
  const serialItemId = devRes.body.item.id as string;
  await agentA.post(RECEIPTS).send({
    occurredOn: '2026-06-01',
    reference: null,
    locationId: mainA,
    lines: [{ itemId: serialItemId, quantityMilli: 1000, unitCostCents: 5000, lot: null, serials: [{ serialNumber: 'SN1', costCents: null, attributes: {} }] }],
  });
  const serialsRes = await agentA.get(`${ITEMS}/${serialItemId}/serials`);
  const serialId = serialsRes.body.serials[0].id as string;

  const userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  const agentB = await loginAgent(app, userB);
  await agentB.post(SETUP).send({ industryProfile: 'MANUFACTURING' });
  const mainB = await locationIdByCode(userB.orgId, 'MAIN');
  const cmpCategoryIdB = await categoryIdByCode(userB.orgId, 'CMP');
  const eaUomIdB = await uomIdByCode(userB.orgId, 'EA');

  // Same code as org A's CMP item: the first CMP item in each fresh org
  // deterministically generates CMP-00001, no manual code needed.
  const cmpResB = await agentB.post(ITEMS).send({ name: 'Foreign bolt', categoryId: cmpCategoryIdB, attributes: { part_number: 'FB1' } });
  const cmpItemIdB = cmpResB.body.item.id as string;

  const devCategoryResB = await agentB.post(CATEGORIES).send({
    code: 'DEV',
    name: 'Devices',
    itemType: 'TRADING_GOOD',
    defaultTracking: 'SERIAL',
    defaultUomId: eaUomIdB,
  });
  const devCategoryIdB = devCategoryResB.body.category.id as string;
  const devResB = await agentB.post(ITEMS).send({ name: 'Foreign sensor', categoryId: devCategoryIdB, attributes: {} });
  await agentB.post(RECEIPTS).send({
    occurredOn: '2026-06-01',
    reference: null,
    locationId: mainB,
    lines: [
      {
        itemId: devResB.body.item.id,
        quantityMilli: 1000,
        unitCostCents: 5000,
        lot: null,
        serials: [{ serialNumber: 'SNB1', costCents: null, attributes: {} }],
      },
    ],
  });
  const serialsResB = await agentB.get(`${ITEMS}/${devResB.body.item.id}/serials`);
  const serialIdB = serialsResB.body.serials[0].id as string;

  return {
    userA,
    orgA: userA.orgId,
    agentA,
    mainA,
    cmpItemId,
    cmpItemCode,
    rmItemId,
    lotId,
    serialItemId,
    serialId,
    cmpItemIdB,
    serialIdB,
  };
}

afterAll(closePool);

describe('POST /stock/labels', () => {
  it('builds an ITEM label with an SVG QR and a scan URL payload', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.post(LABELS).send({ targets: [{ kind: 'ITEM', id: f.cmpItemId, copies: 1 }] });
    expect(res.status).toBe(200);
    const label = res.body.labels[0];
    expect(label.payload).toBe(`${env.FRONTEND_URL.replace(/\/+$/, '')}/app/stock/scan/item/${f.cmpItemId}`);
    expect(label.qrSvg.startsWith('<svg')).toBe(true);
    expect(label.payload).not.toContain(f.orgA);
  });

  it('LOT label subtitle shows expiry', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.post(LABELS).send({ targets: [{ kind: 'LOT', id: f.lotId, copies: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.labels[0].subtitle).toBe('Exp 2027-01-31');
  });

  it('LOCATION label subtitle is the path', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.post(LABELS).send({ targets: [{ kind: 'LOCATION', id: f.mainA, copies: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.labels[0].subtitle).toBe('MAIN');
  });

  it('labels come back in request order with copies', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.post(LABELS).send({
      targets: [
        { kind: 'LOCATION', id: f.mainA, copies: 2 },
        { kind: 'ITEM', id: f.cmpItemId, copies: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.labels.map((l: { kind: string }) => l.kind)).toEqual(['LOCATION', 'ITEM']);
    expect(res.body.labels[0].copies).toBe(2);
  });

  it('over 500 labels → 422 exact message', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.post(LABELS).send({
      targets: Array.from({ length: 6 }, () => ({ kind: 'ITEM', id: f.cmpItemId, copies: 100 })),
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('A label sheet is limited to 500 labels');
  });

  it('label for org B item → 404 "Item not found"', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.post(LABELS).send({ targets: [{ kind: 'ITEM', id: f.cmpItemIdB, copies: 1 }] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Item not found');
  });
});

describe('GET /stock/lookup', () => {
  it('finds item by code, barcode, serial number (case-insensitive), lot and location', async () => {
    await resetTables();
    const f = await buildFixture();

    const byCode = await f.agentA.get(`${LOOKUP}?q=${f.cmpItemCode}`);
    expect(byCode.body.matches.some((m: { kind: string; id: string }) => m.kind === 'ITEM' && m.id === f.cmpItemId)).toBe(
      true,
    );

    const byBarcode = await f.agentA.get(`${LOOKUP}?q=4006381333931`);
    expect(
      byBarcode.body.matches.some((m: { kind: string; id: string }) => m.kind === 'ITEM' && m.id === f.cmpItemId),
    ).toBe(true);

    const bySerial = await f.agentA.get(`${LOOKUP}?q=sn1`);
    expect(
      bySerial.body.matches.some((m: { kind: string; id: string }) => m.kind === 'SERIAL' && m.id === f.serialId),
    ).toBe(true);

    const byLot = await f.agentA.get(`${LOOKUP}?q=l1`);
    expect(byLot.body.matches.some((m: { kind: string; id: string }) => m.kind === 'LOT' && m.id === f.lotId)).toBe(true);

    const byLocation = await f.agentA.get(`${LOOKUP}?q=MAIN`);
    expect(byLocation.body.matches.some((m: { kind: string; id: string }) => m.kind === 'LOCATION' && m.id === f.mainA)).toBe(
      true,
    );
  });

  it('never returns org B matches', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.get(`${LOOKUP}?q=${f.cmpItemCode}`);
    const itemMatches = res.body.matches.filter((m: { kind: string }) => m.kind === 'ITEM');
    expect(itemMatches).toHaveLength(1);
    expect(itemMatches[0].id).toBe(f.cmpItemId);
  });

  it('without q → 400', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.get(LOOKUP);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('q is required');
  });

  it('by lot id returns its item', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.get(`${LOOKUP}?kind=lot&id=${f.lotId}`);
    expect(res.status).toBe(200);
    expect(res.body.match.itemId).toBe(f.rmItemId);
  });

  it('by serial id returns its item', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.get(`${LOOKUP}?kind=serial&id=${f.serialId}`);
    expect(res.status).toBe(200);
    expect(res.body.match.itemId).toBe(f.serialItemId);
  });

  it('by org B serial id → 404 "Serial not found"', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.get(`${LOOKUP}?kind=serial&id=${f.serialIdB}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Serial not found');
  });
});
