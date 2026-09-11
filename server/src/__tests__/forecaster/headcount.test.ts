import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const PLANS_BASE = '/api/v1/forecaster/plans';
const HEADCOUNT_BASE = '/api/v1/forecaster/headcount';

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

describe('forecaster headcount API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let userViewer: SeededUser;
  let planId: string;
  let expenseAccountId: string;

  beforeEach(async () => {
    await resetTables();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');

    const agent = await loginAgent(app, userA);
    const created = await agent.post(PLANS_BASE).send({
      name: 'FY27 Plan',
      startsOn: '2026-10-01',
      horizonMonths: 6,
      actualsThrough: '2026-09-01',
    });
    planId = created.body.plan.id;
    expenseAccountId = await accountId(orgA, '6100');
  });

  afterAll(closePool);

  async function createRole(
    agent: Awaited<ReturnType<typeof loginAgent>>,
    overrides: Record<string, unknown> = {},
  ) {
    return agent.post(`${PLANS_BASE}/${planId}/headcount`).send({
      title: 'Senior Engineer',
      accountId: expenseAccountId,
      startsOn: '2026-10-01',
      fteCount: 2,
      annualSalaryCents: 12_000_000,
      loadingBps: 1800,
      ...overrides,
    });
  }

  it('1. creates a headcount role on an expense account', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createRole(agent);

    expect(res.status).toBe(201);
    expect(res.body.role.fteCount).toBe(2);
    expect(res.body.role.loadingBps).toBe(1800);
  });

  it('2. refuses a Revenue account with 422', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    const res = await createRole(agent, { accountId: revenueAccountId });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('A headcount role must map to an Expense account');
  });

  it('3. refuses a header (non-postable) account with 422', async () => {
    const agent = await loginAgent(app, userA);
    const headerAccountId = await accountId(orgA, '6000');
    const res = await createRole(agent, { accountId: headerAccountId });
    expect(res.status).toBe(422);
  });

  it('4. refuses an inactive account with 422', async () => {
    const agent = await loginAgent(app, userA);
    const retireRes = await agent
      .patch(`/api/v1/ledger-core/accounts/${expenseAccountId}`)
      .send({ isActive: false });
    expect(retireRes.status).toBe(200);

    const res = await createRole(agent);
    expect(res.status).toBe(422);
  });

  it('5. refuses another org\'s account id with 404', async () => {
    const agentB = await loginAgent(app, userB);
    const orgBAccountId = await accountId(userB.orgId, '6100');

    const agentA = await loginAgent(app, userA);
    const res = await createRole(agentA, { accountId: orgBAccountId });
    expect(res.status).toBe(404);
    void agentB;
  });

  it('6. refuses endsOn before startsOn with 422', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createRole(agent, { startsOn: '2026-11-01', endsOn: '2026-10-01' });
    expect(res.status).toBe(422);
  });

  it('7. refuses a negative annualSalaryCents with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createRole(agent, { annualSalaryCents: -1 });
    expect(res.status).toBe(400);
  });

  it('8. lists roles with account code and name joined', async () => {
    const agent = await loginAgent(app, userA);
    await createRole(agent);

    const res = await agent.get(`${PLANS_BASE}/${planId}/headcount`);
    expect(res.status).toBe(200);
    expect(res.body.roles[0].accountCode).toBe('6100');
    expect(res.body.roles[0].accountName).toBe('Salaries & Wages');
  });

  it('9. updates a role\'s FTE count', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createRole(agent);
    const roleId = created.body.role.id;

    const res = await agent.patch(`${HEADCOUNT_BASE}/${roleId}`).send({ fteCount: 5 });
    expect(res.status).toBe(200);
    expect(res.body.role.fteCount).toBe(5);
  });

  it('10. deletes a role', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createRole(agent);
    const roleId = created.body.role.id;

    const res = await agent.delete(`${HEADCOUNT_BASE}/${roleId}`);
    expect(res.status).toBe(200);

    const listRes = await agent.get(`${PLANS_BASE}/${planId}/headcount`);
    expect(listRes.body.count).toBe(0);
  });

  it('11. cross-tenant: org B role id under org A token returns 404', async () => {
    const agentB = await loginAgent(app, userB);
    const orgBExpenseId = await accountId(userB.orgId, '6100');
    const createdPlanRes = await agentB.post(PLANS_BASE).send({
      name: 'Org B Plan',
      startsOn: '2026-10-01',
      horizonMonths: 6,
      actualsThrough: '2026-09-01',
    });
    const planIdB = createdPlanRes.body.plan.id;
    const roleRes = await agentB.post(`${PLANS_BASE}/${planIdB}/headcount`).send({
      title: 'Org B Role',
      accountId: orgBExpenseId,
      startsOn: '2026-10-01',
      fteCount: 1,
      annualSalaryCents: 5_000_000,
      loadingBps: 0,
    });
    const roleId = roleRes.body.role.id;

    const agentA = await loginAgent(app, userA);
    const patchRes = await agentA.patch(`${HEADCOUNT_BASE}/${roleId}`).send({ fteCount: 9 });
    expect(patchRes.status).toBe(404);

    const deleteRes = await agentA.delete(`${HEADCOUNT_BASE}/${roleId}`);
    expect(deleteRes.status).toBe(404);

    const listRes = await agentA.get(`${PLANS_BASE}/${planIdB}/headcount`);
    expect(listRes.status).toBe(404);
  });

  it('12. a VIEWER cannot create a role', async () => {
    const viewerAgent = await loginAgent(app, userViewer);
    await switchTo(viewerAgent, orgA);
    const res = await createRole(viewerAgent);
    expect(res.status).toBe(403);
  });
});
