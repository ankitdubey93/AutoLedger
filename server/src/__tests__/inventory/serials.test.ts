import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Inventory (Phase 28) — manual serial status changes (the real-estate
 * booking flow) and serial custom-field edits. Integration tier, real
 * PostgreSQL. Includes this module's cross-tenant isolation case (rule 15).
 */

const app = createApp();
const SETUP = '/api/v1/inventory/setup';
const ITEMS = '/api/v1/inventory/items';
const RECEIPTS = '/api/v1/inventory/receipts';
const ISSUES = '/api/v1/inventory/issues';
const SERIALS = '/api/v1/inventory/serials';

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

type Agent = Awaited<ReturnType<typeof loginAgent>>;

interface Fixture {
  userA: SeededUser;
  orgA: string;
  agentA: Agent;
  resItemId: string;
  site1Id: string;
  sn1204Id: string;
  sn1205Id: string;
}

/** Apply REAL_ESTATE, create a 2BHK unit item, and receive two serial units at SITE-1. */
async function buildFixture(): Promise<Fixture> {
  const userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  const agentA = await loginAgent(app, userA);
  await agentA.post(SETUP).send({ industryProfile: 'REAL_ESTATE' });

  const resCategoryId = await categoryIdByCode(userA.orgId, 'RES');
  const site1Id = await locationIdByCode(userA.orgId, 'SITE-1');

  const itemRes = await agentA.post(ITEMS).send({
    name: 'Skyline 2BHK',
    categoryId: resCategoryId,
    attributes: { project: 'Skyline', configuration: '2 BHK' },
  });
  const resItemId = itemRes.body.item.id as string;

  const receipt = await agentA.post(RECEIPTS).send({
    occurredOn: '2026-06-01',
    reference: null,
    locationId: site1Id,
    lines: [
      {
        itemId: resItemId,
        quantityMilli: 2000,
        unitCostCents: 650000000,
        lot: null,
        serials: [
          {
            serialNumber: 'A-1204',
            costCents: 650000000,
            attributes: { tower: 'A', floor: '12', carpet_area_sqft: '1180.50', facing: 'East' },
          },
          {
            serialNumber: 'A-1205',
            costCents: 645000000,
            attributes: { tower: 'A', floor: '12', carpet_area_sqft: '1175.00', facing: 'East' },
          },
        ],
      },
    ],
  });
  if (receipt.status !== 201) throw new Error(`fixture: receipt failed: ${JSON.stringify(receipt.body)}`);

  const serialsRes = await agentA.get(`${ITEMS}/${resItemId}/serials`);
  const sn1204 = serialsRes.body.serials.find((s: { serialNumber: string }) => s.serialNumber === 'A-1204');
  const sn1205 = serialsRes.body.serials.find((s: { serialNumber: string }) => s.serialNumber === 'A-1205');

  return {
    userA,
    orgA: userA.orgId,
    agentA,
    resItemId,
    site1Id,
    sn1204Id: sn1204.id as string,
    sn1205Id: sn1205.id as string,
  };
}

afterAll(closePool);

describe('serial status transitions', () => {
  it('real-estate booking flow', async () => {
    await resetTables();
    const f = await buildFixture();

    const booked = await f.agentA
      .post(`${SERIALS}/${f.sn1204Id}/status`)
      .send({ status: 'BOOKED', note: 'Booked by buyer ref 88' });
    expect(booked.status).toBe(200);
    expect(booked.body.serial.status).toBe('BOOKED');

    const issue = await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.site1Id,
      lines: [{ itemId: f.resItemId, quantityMilli: 1000, lotId: null, serialIds: [f.sn1204Id] }],
    });
    expect(issue.status).toBe(201);
    expect(issue.body.movements[0].valueCents).toBe(-650000000);

    const after = await f.agentA.get(`${ITEMS}/${f.resItemId}/serials?status=ISSUED`);
    const sn1204After = after.body.serials.find((s: { serialNumber: string }) => s.serialNumber === 'A-1204');
    expect(sn1204After.status).toBe('ISSUED');
  });

  it('hold then release', async () => {
    await resetTables();
    const f = await buildFixture();

    await f.agentA.post(`${SERIALS}/${f.sn1205Id}/status`).send({ status: 'ON_HOLD', note: null });
    const release = await f.agentA.post(`${SERIALS}/${f.sn1205Id}/status`).send({ status: 'AVAILABLE', note: null });
    expect(release.status).toBe(200);
    expect(release.body.serial.status).toBe('AVAILABLE');
  });

  it('issuing an ON_HOLD unit → 409 "Serial A-1205 is on hold"', async () => {
    await resetTables();
    const f = await buildFixture();

    await f.agentA.post(`${SERIALS}/${f.sn1205Id}/status`).send({ status: 'ON_HOLD', note: null });
    const res = await f.agentA.post(ISSUES).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.site1Id,
      lines: [{ itemId: f.resItemId, quantityMilli: 1000, lotId: null, serialIds: [f.sn1205Id] }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Serial A-1205 is on hold');
  });

  it('manual transition to ISSUED is not accepted (400)', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.post(`${SERIALS}/${f.sn1204Id}/status`).send({ status: 'ISSUED', note: null });
    expect(res.status).toBe(400);
  });

  it('BOOKED → ON_HOLD → 409 "Cannot move serial from BOOKED to ON_HOLD"', async () => {
    await resetTables();
    const f = await buildFixture();

    await f.agentA.post(`${SERIALS}/${f.sn1204Id}/status`).send({ status: 'BOOKED', note: null });
    const res = await f.agentA.post(`${SERIALS}/${f.sn1204Id}/status`).send({ status: 'ON_HOLD', note: null });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot move serial from BOOKED to ON_HOLD');
  });

  it('org B cannot change org A serial status (404)', async () => {
    await resetTables();
    const f = await buildFixture();

    const userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    const agentB = await loginAgent(app, userB);

    const res = await agentB.post(`${SERIALS}/${f.sn1204Id}/status`).send({ status: 'BOOKED', note: null });
    expect(res.status).toBe(404);
  });
});

describe('serial custom fields', () => {
  it('serial receipt with a missing required unit attribute → 422 exact message', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA.post(RECEIPTS).send({
      occurredOn: '2026-06-01',
      reference: null,
      locationId: f.site1Id,
      lines: [
        {
          itemId: f.resItemId,
          quantityMilli: 1000,
          unitCostCents: 600000000,
          lot: null,
          serials: [{ serialNumber: 'A-1301', costCents: null, attributes: { floor: '12', carpet_area_sqft: '1000.00' } }],
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Invalid attributes for serial A-1301: Attribute "Tower" is required');
  });

  it('PATCH serial attributes validates floor as a whole number', async () => {
    await resetTables();
    const f = await buildFixture();

    const res = await f.agentA
      .patch(`${SERIALS}/${f.sn1204Id}`)
      .send({ attributes: { tower: 'A', floor: '12.5', carpet_area_sqft: '1180.50', facing: 'East' } });
    expect(res.status).toBe(422);
  });
});
