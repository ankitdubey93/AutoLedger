import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * unitecon settings API (Phase 14). Integration tier, real PostgreSQL.
 * Includes this module's cross-tenant isolation suite (rule 15).
 */

const app = createApp();
const SETTINGS = '/api/v1/unitecon/settings';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterAll(closePool);

describe('unitecon settings API', () => {
  it('GET with no row returns defaults without writing one', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(SETTINGS);

    expect(res.status).toBe(200);
    expect(res.body.settings.grossMarginBps).toBe(7000);
    expect(res.body.settings.acquisitionAccountIds).toEqual([]);
    expect(res.body.settings.updatedAt).toBeNull();

    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM unitecon_settings WHERE org_id = $1', [
      orgA,
    ]);
    expect(rows[0]?.count).toBe(0);
  });

  it('PATCH sets the margin', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(SETTINGS).send({ grossMarginBps: 6500 });

    expect(res.status).toBe(200);
    expect(res.body.settings.grossMarginBps).toBe(6500);

    const follow = await agent.get(SETTINGS);
    expect(follow.body.settings.grossMarginBps).toBe(6500);
    expect(follow.body.settings.updatedAt).not.toBeNull();
  });

  it('PATCH sets acquisition accounts', async () => {
    const agent = await loginAgent(app, userA);
    const expenseId = await accountId(orgA, '6100');

    const res = await agent.patch(SETTINGS).send({ acquisitionAccountIds: [expenseId] });

    expect(res.status).toBe(200);
    expect(res.body.settings.acquisitionAccountIds).toHaveLength(1);
  });

  it('PATCH replaces rather than merges the acquisition set', async () => {
    const agent = await loginAgent(app, userA);
    const a = await accountId(orgA, '6100');
    const b = await accountId(orgA, '6200');

    await agent.patch(SETTINGS).send({ acquisitionAccountIds: [a, b] });
    const secondRes = await agent.patch(SETTINGS).send({ acquisitionAccountIds: [a] });
    expect(secondRes.body.settings.acquisitionAccountIds).toHaveLength(1);

    const thirdRes = await agent.patch(SETTINGS).send({ acquisitionAccountIds: [] });
    expect(thirdRes.body.settings.acquisitionAccountIds).toHaveLength(0);
  });

  it('rejects a Revenue account as an acquisition account', async () => {
    const agent = await loginAgent(app, userA);
    const revenueId = await accountId(orgA, '4100');

    const res = await agent.patch(SETTINGS).send({ acquisitionAccountIds: [revenueId] });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Expense account');
  });

  it('rejects another org account id with 404', async () => {
    const agentA = await loginAgent(app, userA);
    const otherOrgAccountId = await accountId(orgB, '6100');

    const res = await agentA.patch(SETTINGS).send({ acquisitionAccountIds: [otherOrgAccountId] });

    expect(res.status).toBe(404);
  });

  it('rejects duplicate account ids', async () => {
    const agent = await loginAgent(app, userA);
    const a = await accountId(orgA, '6100');

    const res = await agent.patch(SETTINGS).send({ acquisitionAccountIds: [a, a] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('duplicates');
  });

  it('rejects grossMarginBps out of range', async () => {
    const agent = await loginAgent(app, userA);

    expect((await agent.patch(SETTINGS).send({ grossMarginBps: 10001 })).status).toBe(400);
    expect((await agent.patch(SETTINGS).send({ grossMarginBps: -1 })).status).toBe(400);
    expect((await agent.patch(SETTINGS).send({ grossMarginBps: 70.5 })).status).toBe(400);
  });

  it('rejects an empty body', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(SETTINGS).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('At least one field');
  });

  it('RBAC: ACCOUNTANT cannot PATCH, VIEWER can GET', async () => {
    const accountant = await createUserWithOrg({ label: 'ash', orgName: 'Org Ash Solo' });
    await addMember(orgA, accountant.id, 'ACCOUNTANT');
    const accountantAgent = await loginAgent(app, accountant);
    await switchTo(accountantAgent, orgA);
    const patchRes = await accountantAgent.patch(SETTINGS).send({ grossMarginBps: 5000 });
    expect(patchRes.status).toBe(403);

    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await switchTo(viewerAgent, orgA);
    const getRes = await viewerAgent.get(SETTINGS);
    expect(getRes.status).toBe(200);
  });

  it('never leaks settings across tenants (cross-tenant, both directions)', async () => {
    const agentA = await loginAgent(app, userA);
    const expenseId = await accountId(orgA, '6100');
    await agentA.patch(SETTINGS).send({ grossMarginBps: 6500, acquisitionAccountIds: [expenseId] });

    const agentB = await loginAgent(app, userB);
    const resB = await agentB.get(SETTINGS);
    expect(resB.body.settings.grossMarginBps).toBe(7000);
    expect(resB.body.settings.acquisitionAccountIds).toEqual([]);

    const resA = await agentA.get(SETTINGS);
    expect(resA.body.settings.grossMarginBps).toBe(6500);
    expect(resA.body.settings.acquisitionAccountIds).toHaveLength(1);
  });
});

async function switchTo(agent: Agent, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}
