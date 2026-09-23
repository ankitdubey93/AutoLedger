import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * StockLedger (Phase 28) — items: code generation, custom fields, barcodes.
 * Integration tier, real PostgreSQL. Includes this module's cross-tenant
 * isolation suite (rule 15).
 */

const app = createApp();
const SETUP = '/api/v1/stock/setup';
const ITEMS = '/api/v1/stock/items';
const CODE_SCHEMES = '/api/v1/stock/code-schemes';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function switchTo(agent: Agent, targetOrgId: string): Promise<Agent> {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;
let agentB: Agent;

async function categoryId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM stock_categories WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no category ${code} in org ${orgId}`);
  return row.id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;

  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  await agentA.post(SETUP).send({ industryProfile: 'MANUFACTURING' });
  await agentB.post(SETUP).send({ industryProfile: 'MANUFACTURING' });
});

afterAll(closePool);

describe('code generation', () => {
  it('generates RM-00001 then RM-00002 from the default scheme', async () => {
    const rmId = await categoryId(orgA, 'RM');

    const first = await agentA.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmId, attributes: { grade: 'SS304' } });
    expect(first.status).toBe(201);
    expect(first.body.item.code).toBe('RM-00001');

    const second = await agentA
      .post(ITEMS)
      .send({ name: 'Steel rod', categoryId: rmId, attributes: { grade: 'SS304' } });
    expect(second.status).toBe(201);
    expect(second.body.item.code).toBe('RM-00002');
  });

  it('sequence is per scope: CMP starts at CMP-00001', async () => {
    const cmpId = await categoryId(orgA, 'CMP');
    const res = await agentA.post(ITEMS).send({ name: 'Bolt', categoryId: cmpId, attributes: { part_number: 'B1' } });
    expect(res.status).toBe(201);
    expect(res.body.item.code).toBe('CMP-00001');
  });

  it('uses a chosen scheme', async () => {
    const rmId = await categoryId(orgA, 'RM');
    const scheme = await agentA
      .post(CODE_SCHEMES)
      .send({ name: 'Grade scheme', pattern: '{CAT}-{ATTR:grade:4}-{SEQ:4}' });

    const res = await agentA.post(ITEMS).send({
      name: 'Steel sheet',
      categoryId: rmId,
      codeSchemeId: scheme.body.codeScheme.id,
      attributes: { grade: 'SS304' },
    });
    expect(res.status).toBe(201);
    expect(res.body.item.code).toBe('RM-SS30-0001');
  });

  it('a scheme needing a missing attribute → 422 exact message', async () => {
    const cmpId = await categoryId(orgA, 'CMP');
    const scheme = await agentA.post(CODE_SCHEMES).send({ name: 'Brand scheme', pattern: '{ATTR:brand:3}-{SEQ:5}' });

    const res = await agentA.post(ITEMS).send({
      name: 'Bolt',
      categoryId: cmpId,
      codeSchemeId: scheme.body.codeScheme.id,
      attributes: { part_number: 'B1' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Code scheme needs attribute "brand" to generate a code');
  });

  it('manual code is upper-cased and skipped by the generator', async () => {
    const rmId = await categoryId(orgA, 'RM');

    const manual = await agentA
      .post(ITEMS)
      .send({ name: 'Steel sheet', categoryId: rmId, code: 'rm-00001', attributes: { grade: 'SS304' } });
    expect(manual.status).toBe(201);
    expect(manual.body.item.code).toBe('RM-00001');

    const generated = await agentA
      .post(ITEMS)
      .send({ name: 'Steel rod', categoryId: rmId, attributes: { grade: 'SS304' } });
    expect(generated.status).toBe(201);
    expect(generated.body.item.code).toBe('RM-00002');
  });

  it('a rolled-back create does not burn a sequence number', async () => {
    const rmId = await categoryId(orgA, 'RM');

    const failed = await agentA.post(ITEMS).send({
      name: 'Steel sheet',
      categoryId: rmId,
      attributes: { grade: 'SS304' },
      barcode: '4006381333932', // bad check digit
    });
    expect(failed.status).toBe(422);

    const next = await agentA.post(ITEMS).send({ name: 'Steel rod', categoryId: rmId, attributes: { grade: 'SS304' } });
    expect(next.status).toBe(201);
    expect(next.body.item.code).toBe('RM-00001');
  });

  it('no code and no default scheme → 422 exact message', async () => {
    const rmId = await categoryId(orgA, 'RM');
    await pool.query('UPDATE stock_code_schemes SET is_default = false WHERE org_id = $1', [orgA]);

    const res = await agentA.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmId, attributes: { grade: 'SS304' } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Provide a code or configure a default code scheme');
  });

  it('org A and org B both get RM-00001', async () => {
    const rmA = await categoryId(orgA, 'RM');
    const rmB = await categoryId(orgB, 'RM');

    const a = await agentA.post(ITEMS).send({ name: 'Steel sheet A', categoryId: rmA, attributes: { grade: 'SS304' } });
    const b = await agentB.post(ITEMS).send({ name: 'Steel sheet B', categoryId: rmB, attributes: { grade: 'SS304' } });

    expect(a.body.item.code).toBe('RM-00001');
    expect(b.body.item.code).toBe('RM-00001');
  });
});

describe('validation', () => {
  it('missing required attribute → 422 "Invalid attributes: Attribute \\"Grade\\" is required"', async () => {
    const rmId = await categoryId(orgA, 'RM');
    const res = await agentA.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmId, attributes: {} });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Invalid attributes: Attribute "Grade" is required');
  });

  it('unknown attribute → 422', async () => {
    const rmId = await categoryId(orgA, 'RM');
    const res = await agentA
      .post(ITEMS)
      .send({ name: 'Steel sheet', categoryId: rmId, attributes: { grade: 'SS304', mystery: 'x' } });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Unknown attribute "mystery"');
  });

  it('duplicate manual code → 409 "Item code already exists"', async () => {
    const rmId = await categoryId(orgA, 'RM');
    await agentA.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmId, code: 'RM-X', attributes: { grade: 'SS304' } });

    const dup = await agentA
      .post(ITEMS)
      .send({ name: 'Steel sheet 2', categoryId: rmId, code: 'RM-X', attributes: { grade: 'SS304' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('Item code already exists');
  });

  it('duplicate barcode → 409 "Barcode already used by another item"', async () => {
    const rmId = await categoryId(orgA, 'RM');
    await agentA
      .post(ITEMS)
      .send({ name: 'Steel sheet', categoryId: rmId, attributes: { grade: 'SS304' }, barcode: '4006381333931' });

    const dup = await agentA.post(ITEMS).send({
      name: 'Steel sheet 2',
      categoryId: rmId,
      attributes: { grade: 'SS304' },
      barcode: '4006381333931',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('Barcode already used by another item');
  });

  it('valid EAN-13 accepted, bad check digit → 422', async () => {
    const rmId = await categoryId(orgA, 'RM');
    const ok = await agentA
      .post(ITEMS)
      .send({ name: 'Steel sheet', categoryId: rmId, attributes: { grade: 'SS304' }, barcode: '4006381333931' });
    expect(ok.status).toBe(201);

    const bad = await agentA.post(ITEMS).send({
      name: 'Steel sheet 2',
      categoryId: rmId,
      attributes: { grade: 'SS304' },
      barcode: '4006381333932',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('Barcode check digit is invalid');
  });

  it('serial tracking on a KG item → 422 exact message', async () => {
    const rmId = await categoryId(orgA, 'RM');
    const res = await agentA.post(ITEMS).send({
      name: 'Steel sheet',
      categoryId: rmId,
      tracking: 'SERIAL',
      attributes: { grade: 'SS304' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Serial-tracked items need a whole-number unit of measure');
  });

  it('VIEWER cannot create (403)', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await switchTo(agent, orgA);

    const rmId = await categoryId(orgA, 'RM');
    const res = await agent.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmId, attributes: { grade: 'SS304' } });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /stock/items/:id', () => {
  it('cannot change code (400)', async () => {
    const rmId = await categoryId(orgA, 'RM');
    const created = await agentA.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmId, attributes: { grade: 'SS304' } });

    const res = await agentA.patch(`${ITEMS}/${created.body.item.id}`).send({ code: 'HACKED' });
    expect(res.status).toBe(400);
  });

  it('attributes replaces the whole object', async () => {
    const rmId = await categoryId(orgA, 'RM');
    const created = await agentA.post(ITEMS).send({
      name: 'Steel sheet',
      categoryId: rmId,
      attributes: { grade: 'SS304', specification: 'ASTM A240' },
    });

    const res = await agentA
      .patch(`${ITEMS}/${created.body.item.id}`)
      .send({ attributes: { grade: 'SS316' } });
    expect(res.status).toBe(200);
    expect(res.body.item.attributes).toEqual({ grade: 'SS316' });
  });
});

describe('GET /stock/items', () => {
  it('filters by categoryId and q; paginates', async () => {
    const rmId = await categoryId(orgA, 'RM');
    const cmpId = await categoryId(orgA, 'CMP');

    await agentA.post(ITEMS).send({ name: 'Steel sheet', categoryId: rmId, attributes: { grade: 'SS304' } });
    await agentA.post(ITEMS).send({ name: 'Steel rod', categoryId: rmId, attributes: { grade: 'SS304' } });
    await agentA.post(ITEMS).send({ name: 'Bolt', categoryId: cmpId, attributes: { part_number: 'B1' } });

    const byCategory = await agentA.get(`${ITEMS}?categoryId=${rmId}`);
    expect(byCategory.status).toBe(200);
    expect(byCategory.body.totalCount).toBe(2);

    const byQuery = await agentA.get(`${ITEMS}?q=Bolt`);
    expect(byQuery.body.totalCount).toBe(1);
    expect(byQuery.body.items[0].name).toBe('Bolt');

    const paged = await agentA.get(`${ITEMS}?limit=1&page=2`);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.currentPage).toBe(2);
    expect(paged.body.totalPages).toBe(3);
  });
});

describe('cross-tenant isolation', () => {
  it('GET org B item → 404', async () => {
    const rmB = await categoryId(orgB, 'RM');
    const created = await agentB
      .post(ITEMS)
      .send({ name: 'Foreign sheet', categoryId: rmB, attributes: { grade: 'SS304' } });

    const res = await agentA.get(`${ITEMS}/${created.body.item.id}`);
    expect(res.status).toBe(404);
  });

  it('create with org B categoryId → 422 "Category does not exist in this organization"', async () => {
    const rmB = await categoryId(orgB, 'RM');
    const res = await agentA.post(ITEMS).send({ name: 'Sheet', categoryId: rmB, attributes: { grade: 'SS304' } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Category does not exist in this organization');
  });
});
