import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const PLANS_BASE = '/api/v1/forecaster/plans';

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('forecaster plans API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let userAccountant: SeededUser;
  let userViewer: SeededUser;

  beforeEach(async () => {
    await resetTables();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });

    userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, userAccountant.id, 'ACCOUNTANT');

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
  });

  afterAll(closePool);

  async function createBasicPlan(
    agent: Awaited<ReturnType<typeof loginAgent>>,
    overrides: Partial<{ name: string; startsOn: string; horizonMonths: number; actualsThrough: string }> = {},
  ) {
    const res = await agent.post(PLANS_BASE).send({
      name: 'FY27 Plan',
      startsOn: '2026-10-01',
      horizonMonths: 12,
      actualsThrough: '2026-09-01',
      ...overrides,
    });
    return res;
  }

  it('1. creates a plan', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createBasicPlan(agent);

    expect(res.status).toBe(201);
    expect(res.body.plan.status).toBe('DRAFT');
    expect(res.body.plan.horizonMonths).toBe(12);
  });

  it('2. rejects a duplicate plan name with 409', async () => {
    const agent = await loginAgent(app, userA);
    await createBasicPlan(agent);
    const res = await createBasicPlan(agent);
    expect(res.status).toBe(409);
  });

  it('3. rejects actualsThrough equal to startsOn with 422', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createBasicPlan(agent, { startsOn: '2026-10-01', actualsThrough: '2026-10-01' });
    expect(res.status).toBe(422);
  });

  it('4. rejects a non-first-of-month startsOn with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createBasicPlan(agent, { startsOn: '2026-10-15' });
    expect(res.status).toBe(400);
  });

  it('5. rejects horizonMonths of 61 with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createBasicPlan(agent, { horizonMonths: 61 });
    expect(res.status).toBe(400);
  });

  it('6. lists plans filtered by status', async () => {
    const agent = await loginAgent(app, userA);
    const first = await createBasicPlan(agent, { name: 'Plan One' });
    await createBasicPlan(agent, { name: 'Plan Two' });

    const patchRes = await agent.patch(`${PLANS_BASE}/${first.body.plan.id}`).send({ status: 'ACTIVE' });
    expect(patchRes.status).toBe(200);

    const res = await agent.get(`${PLANS_BASE}?status=ACTIVE`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('7. rejects an unknown status filter with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${PLANS_BASE}?status=NOPE`);
    expect(res.status).toBe(400);
  });

  it('8. refuses an illegal status transition with 409', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createBasicPlan(agent);
    const planId = created.body.plan.id;

    const toArchived = await agent.patch(`${PLANS_BASE}/${planId}`).send({ status: 'ARCHIVED' });
    expect(toArchived.status).toBe(200);

    const toDraft = await agent.patch(`${PLANS_BASE}/${planId}`).send({ status: 'DRAFT' });
    expect(toDraft.status).toBe(409);
  });

  it('9. allows ARCHIVED -> ACTIVE', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createBasicPlan(agent);
    const planId = created.body.plan.id;

    await agent.patch(`${PLANS_BASE}/${planId}`).send({ status: 'ARCHIVED' });
    const res = await agent.patch(`${PLANS_BASE}/${planId}`).send({ status: 'ACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.plan.status).toBe('ACTIVE');
  });

  it('10. rolls a plan forward one month, horizon unchanged', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createBasicPlan(agent, {
      startsOn: '2026-10-01',
      actualsThrough: '2026-09-01',
      horizonMonths: 12,
    });
    const planId = created.body.plan.id;

    const res = await agent.post(`${PLANS_BASE}/${planId}/roll`);
    expect(res.status).toBe(200);
    expect(res.body.plan.startsOn).toBe('2026-11-01');
    expect(res.body.plan.actualsThrough).toBe('2026-10-01');
    expect(res.body.plan.horizonMonths).toBe(12);
  });

  it('11. refuses to roll an archived plan with 409', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createBasicPlan(agent);
    const planId = created.body.plan.id;

    await agent.patch(`${PLANS_BASE}/${planId}`).send({ status: 'ARCHIVED' });
    const res = await agent.post(`${PLANS_BASE}/${planId}/roll`);
    expect(res.status).toBe(409);
  });

  it('12. cross-tenant: org B plan id under org A token returns 404, not 403', async () => {
    const agentB = await loginAgent(app, userB);
    const created = await createBasicPlan(agentB);
    const planId = created.body.plan.id;

    const agentA = await loginAgent(app, userA);
    const getRes = await agentA.get(`${PLANS_BASE}/${planId}`);
    expect(getRes.status).toBe(404);

    const patchRes = await agentA.patch(`${PLANS_BASE}/${planId}`).send({ name: 'Hijacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await agentA.delete(`${PLANS_BASE}/${planId}`);
    expect(deleteRes.status).toBe(404);

    const rollRes = await agentA.post(`${PLANS_BASE}/${planId}/roll`);
    expect(rollRes.status).toBe(404);

    const { rows } = await pool.query<{ name: string }>('SELECT name FROM forecaster_plans WHERE id = $1', [
      planId,
    ]);
    expect(rows[0]?.name).toBe('FY27 Plan');
  });

  it('13. a VIEWER cannot create a plan', async () => {
    const agent = await loginAgent(app, userViewer);
    await switchTo(agent, orgA);
    const res = await createBasicPlan(agent);
    expect(res.status).toBe(403);
  });

  it('14. a VIEWER can list plans', async () => {
    const agent = await loginAgent(app, userViewer);
    await switchTo(agent, orgA);
    const res = await agent.get(PLANS_BASE);
    expect(res.status).toBe(200);
  });

  it('15. an ACCOUNTANT cannot delete a plan', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const created = await createBasicPlan(ownerAgent);
    const planId = created.body.plan.id;

    const accountantAgent = await loginAgent(app, userAccountant);
    await switchTo(accountantAgent, orgA);
    const res = await accountantAgent.delete(`${PLANS_BASE}/${planId}`);
    expect(res.status).toBe(403);
  });
});
