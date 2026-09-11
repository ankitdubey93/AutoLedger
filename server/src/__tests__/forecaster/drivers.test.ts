import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const PLANS_BASE = '/api/v1/forecaster/plans';
const DRIVERS_BASE = '/api/v1/forecaster/drivers';

async function switchTo(agent: Awaited<ReturnType<typeof loginAgent>>, targetOrgId: string) {
  const res = await agent.post('/api/v1/auth/switch-org').send({ orgId: targetOrgId });
  expect(res.status).toBe(200);
  return agent;
}

describe('forecaster drivers API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let userViewer: SeededUser;

  beforeEach(async () => {
    await resetTables();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
  });

  afterAll(closePool);

  async function createPlan(agent: Awaited<ReturnType<typeof loginAgent>>, name = 'FY27 Plan') {
    const res = await agent.post(PLANS_BASE).send({
      name,
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    return res.body.plan.id as string;
  }

  async function createDriver(
    agent: Awaited<ReturnType<typeof loginAgent>>,
    planId: string,
    overrides: Partial<{ name: string; unitLabel: string; kind: string }> = {},
  ) {
    return agent.post(`${PLANS_BASE}/${planId}/drivers`).send({
      name: 'New customers',
      unitLabel: 'customers',
      kind: 'COUNT',
      ...overrides,
    });
  }

  it('1. creates a COUNT driver on a plan', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const res = await createDriver(agent, planId);

    expect(res.status).toBe(201);
    expect(res.body.driver.kind).toBe('COUNT');
  });

  it('2. rejects a duplicate driver name on the same plan with 409', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    await createDriver(agent, planId);
    const res = await createDriver(agent, planId);
    expect(res.status).toBe(409);
  });

  it('3. allows the same driver name on a different plan', async () => {
    const agent = await loginAgent(app, userA);
    const planId1 = await createPlan(agent, 'Plan One');
    const planId2 = await createPlan(agent, 'Plan Two');
    await createDriver(agent, planId1);
    const res = await createDriver(agent, planId2);
    expect(res.status).toBe(201);
  });

  it('4. rejects an unknown kind with 400', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const res = await createDriver(agent, planId, { kind: 'FLOAT' });
    expect(res.status).toBe(400);
  });

  it('5. sets and reads back monthly values', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const created = await createDriver(agent, planId);
    const driverId = created.body.driver.id;

    const putRes = await agent.put(`${DRIVERS_BASE}/${driverId}/values`).send({
      values: [
        { month: '2026-10-01', value: 10 },
        { month: '2026-11-01', value: 20 },
        { month: '2026-12-01', value: 30 },
      ],
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.count).toBe(3);

    const getRes = await agent.get(`${DRIVERS_BASE}/${driverId}/values`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.values.map((v: { month: string }) => v.month)).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
    ]);
  });

  it('6. overwrites an existing month rather than duplicating it', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const created = await createDriver(agent, planId);
    const driverId = created.body.driver.id;

    await agent.put(`${DRIVERS_BASE}/${driverId}/values`).send({
      values: [{ month: '2026-10-01', value: 10 }],
    });
    const res = await agent.put(`${DRIVERS_BASE}/${driverId}/values`).send({
      values: [{ month: '2026-10-01', value: 99 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.values[0].value).toBe(99);
  });

  it('7. refuses a negative value on a COUNT driver with 422', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const created = await createDriver(agent, planId);
    const driverId = created.body.driver.id;

    const res = await agent.put(`${DRIVERS_BASE}/${driverId}/values`).send({
      values: [{ month: '2026-10-01', value: -5 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('A COUNT or BPS driver value cannot be negative');
  });

  it('8. accepts a negative value on a CENTS driver', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const created = await createDriver(agent, planId, { kind: 'CENTS', name: 'Refund rate' });
    const driverId = created.body.driver.id;

    const res = await agent.put(`${DRIVERS_BASE}/${driverId}/values`).send({
      values: [{ month: '2026-10-01', value: -500 }],
    });
    expect(res.status).toBe(200);
  });

  it('9. rejects a non-first-of-month month with 400', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const created = await createDriver(agent, planId);
    const driverId = created.body.driver.id;

    const res = await agent.put(`${DRIVERS_BASE}/${driverId}/values`).send({
      values: [{ month: '2026-10-15', value: 5 }],
    });
    expect(res.status).toBe(400);
  });

  it('10. rolling a plan drops the front month and copies the last month forward', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const created = await createDriver(agent, planId);
    const driverId = created.body.driver.id;

    await agent.put(`${DRIVERS_BASE}/${driverId}/values`).send({
      values: [
        { month: '2026-10-01', value: 100 },
        { month: '2026-11-01', value: 200 },
        { month: '2026-12-01', value: 300 },
      ],
    });

    const rollRes = await agent.post(`${PLANS_BASE}/${planId}/roll`);
    expect(rollRes.status).toBe(200);

    const getRes = await agent.get(`${DRIVERS_BASE}/${driverId}/values`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.values).toHaveLength(3);
    expect(getRes.body.values).toEqual([
      { driverId, month: '2026-11-01', value: 200 },
      { driverId, month: '2026-12-01', value: 300 },
      { driverId, month: '2027-01-01', value: 300 },
    ]);
  });

  it('11. a driver with no value in the copied month simply gains none', async () => {
    const agent = await loginAgent(app, userA);
    const planId = await createPlan(agent);
    const created = await createDriver(agent, planId, { name: 'Empty driver' });
    const driverId = created.body.driver.id;

    const rollRes = await agent.post(`${PLANS_BASE}/${planId}/roll`);
    expect(rollRes.status).toBe(200);

    const getRes = await agent.get(`${DRIVERS_BASE}/${driverId}/values`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.count).toBe(0);
  });

  it('12. cross-tenant: org B driver id under org A token returns 404', async () => {
    const agentB = await loginAgent(app, userB);
    const planIdB = await createPlan(agentB);
    const created = await createDriver(agentB, planIdB);
    const driverId = created.body.driver.id;

    const agentA = await loginAgent(app, userA);

    const patchRes = await agentA.patch(`${DRIVERS_BASE}/${driverId}`).send({ name: 'Hijacked' });
    expect(patchRes.status).toBe(404);

    const deleteRes = await agentA.delete(`${DRIVERS_BASE}/${driverId}`);
    expect(deleteRes.status).toBe(404);

    const getValuesRes = await agentA.get(`${DRIVERS_BASE}/${driverId}/values`);
    expect(getValuesRes.status).toBe(404);

    const putValuesRes = await agentA
      .put(`${DRIVERS_BASE}/${driverId}/values`)
      .send({ values: [{ month: '2026-10-01', value: 1 }] });
    expect(putValuesRes.status).toBe(404);

    const listDriversRes = await agentA.get(`${PLANS_BASE}/${planIdB}/drivers`);
    expect(listDriversRes.status).toBe(404);
  });

  it('13. a VIEWER cannot set driver values', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const planId = await createPlan(ownerAgent);
    const created = await createDriver(ownerAgent, planId);
    const driverId = created.body.driver.id;

    const viewerAgent = await loginAgent(app, userViewer);
    await switchTo(viewerAgent, orgA);
    const res = await viewerAgent
      .put(`${DRIVERS_BASE}/${driverId}/values`)
      .send({ values: [{ month: '2026-10-01', value: 1 }] });
    expect(res.status).toBe(403);
  });
});
