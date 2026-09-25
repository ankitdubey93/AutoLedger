import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Inventory (Phase 28) — item-code schemes: create, default-swap,
 * preview, presets. Integration tier, real PostgreSQL. Includes this
 * module's cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const CATEGORIES = '/api/v1/inventory/categories';
const CODE_SCHEMES = '/api/v1/inventory/code-schemes';

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

describe('POST /inventory/code-schemes', () => {
  it('creates a scheme and returns an example', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(CODE_SCHEMES).send({ name: 'Category + year', pattern: '{CAT}-{YY}-{SEQ:4}' });

    expect(res.status).toBe(201);
    expect(res.body.codeScheme.example).toMatch(/^CAT-\d{2}-0001$/);
  });

  it('invalid pattern → 422 "Invalid code pattern: Pattern needs exactly one {SEQ:n}"', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(CODE_SCHEMES).send({ name: 'Broken', pattern: '{CAT}' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Invalid code pattern: Pattern needs exactly one {SEQ:n}');
  });

  it('making a scheme default unsets the previous default', async () => {
    const agent = await loginAgent(app, userA);
    await agent.post(CODE_SCHEMES).send({ name: 'First', pattern: '{SEQ:5}', isDefault: true });
    await agent.post(CODE_SCHEMES).send({ name: 'Second', pattern: '{SEQ:6}', isDefault: true });

    const { rows } = await pool.query('SELECT name FROM stock_code_schemes WHERE org_id = $1 AND is_default', [orgA]);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { name: string }).name).toBe('Second');
  });
});

describe('PATCH /inventory/code-schemes/:id', () => {
  it('cannot deactivate the default (422)', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(CODE_SCHEMES).send({ name: 'Only', pattern: '{SEQ:5}', isDefault: true });

    const res = await agent.patch(`${CODE_SCHEMES}/${created.body.codeScheme.id}`).send({ isActive: false });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Choose another default before deactivating this scheme');
  });

  it('PATCH org B scheme → 404', async () => {
    const agentB = await loginAgent(app, userB);
    const created = await agentB.post(CODE_SCHEMES).send({ name: 'Foreign', pattern: '{SEQ:5}' });

    const agentA = await loginAgent(app, userA);
    const res = await agentA.patch(`${CODE_SCHEMES}/${created.body.codeScheme.id}`).send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
  });
});

describe('POST /inventory/code-schemes/preview', () => {
  it('renders with a category', async () => {
    const agent = await loginAgent(app, userA);
    const category = await agent
      .post(CATEGORIES)
      .send({ code: 'RM', name: 'Raw materials', itemType: 'RAW_MATERIAL', defaultTracking: 'QUANTITY' });

    const res = await agent
      .post(`${CODE_SCHEMES}/preview`)
      .send({ pattern: '{CAT}-{SEQ:5}', categoryId: category.body.category.id });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.example).toBe('RM-00001');
  });

  it('of a bad pattern is 200 valid:false', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${CODE_SCHEMES}/preview`).send({ pattern: '{FOO}-{SEQ:4}' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('with org B categoryId → 422', async () => {
    const agentB = await loginAgent(app, userB);
    const category = await agentB
      .post(CATEGORIES)
      .send({ code: 'FOR', name: 'Foreign', itemType: 'TRADING_GOOD', defaultTracking: 'QUANTITY' });

    const agentA = await loginAgent(app, userA);
    const res = await agentA
      .post(`${CODE_SCHEMES}/preview`)
      .send({ pattern: '{CAT}-{SEQ:5}', categoryId: category.body.category.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Category does not exist in this organization');
  });
});

describe('GET /inventory/code-schemes/presets', () => {
  it('lists 7 entries', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${CODE_SCHEMES}/presets`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(7);
    expect(res.body.presets).toHaveLength(7);
  });
});
