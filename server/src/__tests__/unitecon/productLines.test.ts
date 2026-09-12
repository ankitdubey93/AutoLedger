import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * unitecon product-lines API (Phase 14). Integration tier, real PostgreSQL.
 * Includes this module's cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const PRODUCT_LINES = '/api/v1/unitecon/product-lines';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function switchTo(agent: Agent, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

describe('unitecon product-lines API', () => {
  it('creates a product line over a Revenue account', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId, name: 'Widgets', unitLabel: 'unit' });

    expect(res.status).toBe(201);
    expect(res.body.productLine.revenueAccountCode).toBe('4100');
    expect(res.body.productLine.revenueAccountName).toBe('Product Revenue');
  });

  it('rejects a non-Revenue account', async () => {
    const agent = await loginAgent(app, userA);
    const expenseAccountId = await accountId(orgA, '6100');

    const res = await agent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId: expenseAccountId, name: 'Widgets', unitLabel: '' });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Revenue account');
  });

  it('rejects a header (non-postable) account', async () => {
    const agent = await loginAgent(app, userA);
    const headerAccountId = await accountId(orgA, '4000');

    const res = await agent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId: headerAccountId, name: 'Widgets', unitLabel: '' });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('postable account');
  });

  it('rejects another org account id with 404', async () => {
    const agentA = await loginAgent(app, userA);
    const otherOrgAccountId = await accountId(orgB, '4100');

    const res = await agentA
      .post(PRODUCT_LINES)
      .send({ revenueAccountId: otherOrgAccountId, name: 'Widgets', unitLabel: '' });

    expect(res.status).toBe(404);
  });

  it('rejects a duplicate account', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    await agent.post(PRODUCT_LINES).send({ revenueAccountId, name: 'Widgets', unitLabel: '' });

    const res = await agent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId, name: 'Widgets 2', unitLabel: '' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already has a product line');
  });

  it('rejects a duplicate name over a different account', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId4100 = await accountId(orgA, '4100');
    const revenueAccountId4200 = await accountId(orgA, '4200');
    await agent.post(PRODUCT_LINES).send({ revenueAccountId: revenueAccountId4100, name: 'Widgets', unitLabel: '' });

    const res = await agent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId: revenueAccountId4200, name: 'Widgets', unitLabel: '' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('name already exists');
  });

  it('rejects a blank name', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agent.post(PRODUCT_LINES).send({ revenueAccountId, name: '   ', unitLabel: '' });
    expect(res.status).toBe(400);
  });

  it('list excludes inactive by default, includes with includeInactive=true', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId, name: 'Widgets', unitLabel: '' });
    const id = created.body.productLine.id as string;

    await agent.patch(`${PRODUCT_LINES}/${id}`).send({ isActive: false });

    const defaultList = await agent.get(PRODUCT_LINES);
    expect(defaultList.body.productLines).toHaveLength(0);

    const withInactive = await agent.get(PRODUCT_LINES).query({ includeInactive: 'true' });
    expect(withInactive.body.productLines).toHaveLength(1);
  });

  it('PATCH cannot change the account (unknown key is stripped, so a lone revenueAccountId is treated as empty)', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId4100 = await accountId(orgA, '4100');
    const revenueAccountId4200 = await accountId(orgA, '4200');
    const created = await agent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId: revenueAccountId4100, name: 'Widgets', unitLabel: '' });
    const id = created.body.productLine.id as string;

    const res = await agent.patch(`${PRODUCT_LINES}/${id}`).send({ revenueAccountId: revenueAccountId4200 });
    expect(res.status).toBe(400);

    const { rows } = await pool.query<{ revenue_account_id: string }>(
      'SELECT revenue_account_id FROM unitecon_product_lines WHERE id = $1',
      [id],
    );
    expect(rows[0]?.revenue_account_id).toBe(revenueAccountId4100);
  });

  it('DELETE removes the row', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId, name: 'Widgets', unitLabel: '' });
    const id = created.body.productLine.id as string;

    const res = await agent.delete(`${PRODUCT_LINES}/${id}`);
    expect(res.status).toBe(200);

    const list = await agent.get(PRODUCT_LINES).query({ includeInactive: 'true' });
    expect(list.body.productLines).toHaveLength(0);
  });

  it('cross-tenant PATCH and DELETE both 404, never 403 or 200', async () => {
    const agentA = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgB, '4100');

    const agentB = await loginAgent(app, userB);
    const created = await agentB
      .post(PRODUCT_LINES)
      .send({ revenueAccountId, name: 'Widgets', unitLabel: '' });
    const idInOrgB = created.body.productLine.id as string;

    const patchRes = await agentA.patch(`${PRODUCT_LINES}/${idInOrgB}`).send({ name: 'Hacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await agentA.delete(`${PRODUCT_LINES}/${idInOrgB}`);
    expect(deleteRes.status).toBe(404);
  });

  it('RBAC: ACCOUNTANT can POST/PATCH but not DELETE; VIEWER can GET but not POST', async () => {
    const revenueAccountId = await accountId(orgA, '4100');

    const accountant = await createUserWithOrg({ label: 'ash', orgName: 'Org Ash Solo' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const accountantAgent = await loginAgent(app, accountant);
    await switchTo(accountantAgent, orgA);

    const created = await accountantAgent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId, name: 'Widgets', unitLabel: '' });
    expect(created.status).toBe(201);
    const id = created.body.productLine.id as string;

    const patched = await accountantAgent.patch(`${PRODUCT_LINES}/${id}`).send({ name: 'Widgets v2' });
    expect(patched.status).toBe(200);

    const deleted = await accountantAgent.delete(`${PRODUCT_LINES}/${id}`);
    expect(deleted.status).toBe(403);

    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await switchTo(viewerAgent, orgA);

    const viewerGet = await viewerAgent.get(PRODUCT_LINES);
    expect(viewerGet.status).toBe(200);

    const viewerPost = await viewerAgent
      .post(PRODUCT_LINES)
      .send({ revenueAccountId, name: 'Should not work', unitLabel: '' });
    expect(viewerPost.status).toBe(403);
  });
});
