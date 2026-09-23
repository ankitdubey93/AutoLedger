import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * StockLedger (Phase 28) — the catalogue: units of measure, categories and
 * their custom-field definitions. Integration tier, real PostgreSQL.
 * Includes this module's cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const UOMS = '/api/v1/stock/uoms';
const CATEGORIES = '/api/v1/stock/categories';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function switchTo(agent: Agent, targetOrgId: string): Promise<Agent> {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
});

afterAll(closePool);

describe('UoMs', () => {
  it('creates a UoM and rejects a duplicate code (409)', async () => {
    const agent = await loginAgent(app, userA);

    const created = await agent.post(UOMS).send({ code: 'BOX', name: 'Box', decimalPlaces: 0 });
    expect(created.status).toBe(201);
    expect(created.body.uom.code).toBe('BOX');

    const dup = await agent.post(UOMS).send({ code: 'BOX', name: 'Box again', decimalPlaces: 0 });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('Unit of measure code already exists');
  });

  it('lower-case UoM code is upper-cased', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(UOMS).send({ code: 'kg', name: 'Kilogram', decimalPlaces: 3 });
    expect(res.status).toBe(201);
    expect(res.body.uom.code).toBe('KG');
  });

  it('PATCH org B UoM → 404', async () => {
    const agentB = await loginAgent(app, userB);
    const created = await agentB.post(UOMS).send({ code: 'EA', name: 'Each', decimalPlaces: 0 });

    const agentA = await loginAgent(app, userA);
    const res = await agentA.patch(`${UOMS}/${created.body.uom.id}`).send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
  });
});

describe('Categories', () => {
  it('creates nested categories and returns path', async () => {
    const agent = await loginAgent(app, userA);

    const rm = await agent.post(CATEGORIES).send({
      code: 'RM',
      name: 'Raw materials',
      itemType: 'RAW_MATERIAL',
      defaultTracking: 'QUANTITY',
    });
    expect(rm.status).toBe(201);

    const rms = await agent.post(CATEGORIES).send({
      code: 'RMS',
      name: 'Steel',
      itemType: 'RAW_MATERIAL',
      defaultTracking: 'QUANTITY',
      parentId: rm.body.category.id,
    });
    expect(rms.status).toBe(201);
    expect(rms.body.category.path).toBe('Raw materials / Steel');
    expect(rms.body.category.depth).toBe(2);
  });

  it('refuses a 4th nesting level (422 exact message)', async () => {
    const agent = await loginAgent(app, userA);

    async function makeCategory(code: string, parentId: string | null) {
      const res = await agent
        .post(CATEGORIES)
        .send({ code, name: code, itemType: 'TRADING_GOOD', defaultTracking: 'QUANTITY', parentId });
      expect(res.status).toBe(201);
      return res.body.category.id as string;
    }

    const l1 = await makeCategory('L1', null);
    const l2 = await makeCategory('L2', l1);
    const l3 = await makeCategory('L3', l2);

    const res = await agent
      .post(CATEGORIES)
      .send({ code: 'L4', name: 'L4', itemType: 'TRADING_GOOD', defaultTracking: 'QUANTITY', parentId: l3 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Categories can be nested at most 3 levels deep');
  });

  it('parent from org B is refused (422)', async () => {
    const agentB = await loginAgent(app, userB);
    const foreign = await agentB.post(CATEGORIES).send({
      code: 'FOR',
      name: 'Foreign',
      itemType: 'TRADING_GOOD',
      defaultTracking: 'QUANTITY',
    });

    const agentA = await loginAgent(app, userA);
    const res = await agentA.post(CATEGORIES).send({
      code: 'GEN',
      name: 'General',
      itemType: 'TRADING_GOOD',
      defaultTracking: 'QUANTITY',
      parentId: foreign.body.category.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Parent category does not exist in this organization');
  });

  it('cannot PATCH code (400)', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent
      .post(CATEGORIES)
      .send({ code: 'RM', name: 'Raw materials', itemType: 'RAW_MATERIAL', defaultTracking: 'QUANTITY' });

    const res = await agent.patch(`${CATEGORIES}/${created.body.category.id}`).send({ code: 'RM2' });
    expect(res.status).toBe(400);
  });

  it('ACCOUNTANT cannot create a category (403)', async () => {
    const accountant = await createUserWithOrg({ label: 'ash', orgName: 'Org Ash Solo' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const agent = await loginAgent(app, accountant);
    await switchTo(agent, orgA);

    const res = await agent
      .post(CATEGORIES)
      .send({ code: 'RM', name: 'Raw materials', itemType: 'RAW_MATERIAL', defaultTracking: 'QUANTITY' });
    expect(res.status).toBe(403);
  });

  it('GET /categories/:id with org B id → 404', async () => {
    const agentB = await loginAgent(app, userB);
    const created = await agentB.post(CATEGORIES).send({
      code: 'FOR',
      name: 'Foreign',
      itemType: 'TRADING_GOOD',
      defaultTracking: 'QUANTITY',
    });

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${CATEGORIES}/${created.body.category.id}`);
    expect(res.status).toBe(404);
  });
});

describe('Attribute definitions', () => {
  async function makeCategory(agent: Agent, code = 'RM'): Promise<string> {
    const res = await agent
      .post(CATEGORIES)
      .send({ code, name: code, itemType: 'RAW_MATERIAL', defaultTracking: 'QUANTITY' });
    expect(res.status).toBe(201);
    return res.body.category.id as string;
  }

  it('adds a SELECT attribute; missing options → 400', async () => {
    const agent = await loginAgent(app, userA);
    const categoryId = await makeCategory(agent);

    const ok = await agent.post(`${CATEGORIES}/${categoryId}/attributes`).send({
      key: 'grade',
      label: 'Grade',
      appliesTo: 'ITEM',
      dataType: 'SELECT',
      options: ['A', 'B'],
    });
    expect(ok.status).toBe(201);

    const missing = await agent.post(`${CATEGORIES}/${categoryId}/attributes`).send({
      key: 'storage',
      label: 'Storage',
      appliesTo: 'ITEM',
      dataType: 'SELECT',
    });
    expect(missing.status).toBe(400);
  });

  it('duplicate attribute key → 409', async () => {
    const agent = await loginAgent(app, userA);
    const categoryId = await makeCategory(agent);

    await agent.post(`${CATEGORIES}/${categoryId}/attributes`).send({
      key: 'brand',
      label: 'Brand',
      appliesTo: 'ITEM',
      dataType: 'TEXT',
    });

    const dup = await agent.post(`${CATEGORIES}/${categoryId}/attributes`).send({
      key: 'brand',
      label: 'Brand again',
      appliesTo: 'ITEM',
      dataType: 'TEXT',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('Attribute key already exists on this category');
  });

  it('PATCH options on a TEXT attribute → 422', async () => {
    const agent = await loginAgent(app, userA);
    const categoryId = await makeCategory(agent);

    const created = await agent.post(`${CATEGORIES}/${categoryId}/attributes`).send({
      key: 'brand',
      label: 'Brand',
      appliesTo: 'ITEM',
      dataType: 'TEXT',
    });

    const res = await agent
      .patch(`${CATEGORIES}/${categoryId}/attributes/${created.body.attribute.id}`)
      .send({ options: ['X', 'Y'] });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only SELECT attributes have options');
  });
});
