import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const PLANS_BASE = '/api/v1/forecaster/plans';
const DRIVERS_BASE = '/api/v1/forecaster/drivers';
const LINES_BASE = '/api/v1/forecaster/forecast-lines';

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

describe('forecaster forecast lines and build API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let orgB: string;
  let userViewer: SeededUser;
  let planId: string;
  let revenueAccountId: string;
  let liabilityAccountId: string;
  let qtyDriverId: string;
  let rateDriverId: string;

  beforeEach(async () => {
    await resetTables();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;

    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');

    const agent = await loginAgent(app, userA);
    const createdPlan = await agent.post(PLANS_BASE).send({
      name: 'FY27 Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    planId = createdPlan.body.plan.id;

    revenueAccountId = await accountId(orgA, '4100');
    liabilityAccountId = await accountId(orgA, '2100');

    const qtyDriver = await agent.post(`${PLANS_BASE}/${planId}/drivers`).send({
      name: 'New customers',
      unitLabel: 'customers',
      kind: 'COUNT',
    });
    qtyDriverId = qtyDriver.body.driver.id;

    const rateDriver = await agent.post(`${PLANS_BASE}/${planId}/drivers`).send({
      name: 'Price per customer',
      unitLabel: 'cents',
      kind: 'CENTS',
    });
    rateDriverId = rateDriver.body.driver.id;
  });

  afterAll(closePool);

  async function createProductLine(
    agent: Awaited<ReturnType<typeof loginAgent>>,
    overrides: Record<string, unknown> = {},
  ) {
    return agent.post(`${PLANS_BASE}/${planId}/forecast-lines`).send({
      kind: 'DRIVER_PRODUCT',
      accountId: revenueAccountId,
      label: 'Subscription revenue',
      quantityDriverId: qtyDriverId,
      rateDriverId,
      ...overrides,
    });
  }

  it('1. creates a DRIVER_PRODUCT line', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createProductLine(agent);
    expect(res.status).toBe(201);
    expect(res.body.line.kind).toBe('DRIVER_PRODUCT');
  });

  it('2. refuses a DRIVER_PRODUCT whose quantity driver is CENTS with 422', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createProductLine(agent, { quantityDriverId: rateDriverId });
    expect(res.status).toBe(422);
  });

  it('3. refuses a DRIVER_PERCENT whose source driver is COUNT with 422', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${PLANS_BASE}/${planId}/forecast-lines`).send({
      kind: 'DRIVER_PERCENT',
      accountId: revenueAccountId,
      label: 'Discounts',
      sourceDriverId: qtyDriverId,
      percentBps: 500,
    });
    expect(res.status).toBe(422);
  });

  it('4. refuses a line referencing a driver on another plan with 422', async () => {
    const agent = await loginAgent(app, userA);
    const otherPlan = await agent.post(PLANS_BASE).send({
      name: 'Other Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    const otherDriver = await agent.post(`${PLANS_BASE}/${otherPlan.body.plan.id}/drivers`).send({
      name: 'Foreign driver',
      unitLabel: 'x',
      kind: 'COUNT',
    });
    const res = await createProductLine(agent, { quantityDriverId: otherDriver.body.driver.id });
    expect(res.status).toBe(422);
  });

  it('5. refuses a kind/payload mismatch with 400', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(`${PLANS_BASE}/${planId}/forecast-lines`).send({
      kind: 'FIXED_CENTS',
      accountId: revenueAccountId,
      label: 'Bad line',
      quantityDriverId: qtyDriverId,
      rateDriverId,
    });
    expect(res.status).toBe(400);
  });

  it('6. refuses a duplicate label on the same plan with 409', async () => {
    const agent = await loginAgent(app, userA);
    await createProductLine(agent);
    const res = await createProductLine(agent);
    expect(res.status).toBe(409);
  });

  it('7. refuses a Liability account with 422', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createProductLine(agent, { accountId: liabilityAccountId });
    expect(res.status).toBe(422);
  });

  it('8. computes a forecast end to end', async () => {
    const agent = await loginAgent(app, userA);
    await createProductLine(agent);

    await agent.put(`${DRIVERS_BASE}/${qtyDriverId}/values`).send({
      values: [
        { month: '2026-10-01', value: 10 },
        { month: '2026-11-01', value: 20 },
        { month: '2026-12-01', value: 30 },
      ],
    });
    await agent.put(`${DRIVERS_BASE}/${rateDriverId}/values`).send({
      values: [
        { month: '2026-10-01', value: 100000 },
        { month: '2026-11-01', value: 100000 },
        { month: '2026-12-01', value: 100000 },
      ],
    });

    const res = await agent.get(`${PLANS_BASE}/${planId}/forecast`);
    expect(res.status).toBe(200);
    const months = res.body.forecast.build.months;
    expect(months[0].lines[0].amountCents).toBe(1_000_000);
    expect(months[1].lines[0].amountCents).toBe(2_000_000);
    expect(months[2].lines[0].amountCents).toBe(3_000_000);
  });

  it('9. flags a month whose driver has no value', async () => {
    const agent = await loginAgent(app, userA);
    await createProductLine(agent);

    await agent.put(`${DRIVERS_BASE}/${qtyDriverId}/values`).send({
      values: [
        { month: '2026-10-01', value: 10 },
        { month: '2026-12-01', value: 30 },
      ],
    });
    await agent.put(`${DRIVERS_BASE}/${rateDriverId}/values`).send({
      values: [
        { month: '2026-10-01', value: 100000 },
        { month: '2026-11-01', value: 100000 },
        { month: '2026-12-01', value: 100000 },
      ],
    });

    const res = await agent.get(`${PLANS_BASE}/${planId}/forecast`);
    expect(res.status).toBe(200);
    const months = res.body.forecast.build.months;
    expect(months[1].lines[0].amountCents).toBe(0);
    expect(months[1].lines[0].missingDriverValue).toBe(true);
    expect(res.body.forecast.build.hasMissingDriverValues).toBe(true);
  });

  it('10. includes headcount cost in the same account total', async () => {
    const agent = await loginAgent(app, userA);
    const expenseAccountId = await accountId(orgA, '6100');

    await agent.post(`${PLANS_BASE}/${planId}/forecast-lines`).send({
      kind: 'FIXED_CENTS',
      accountId: expenseAccountId,
      label: 'Software subscriptions',
      fixedCents: 750_000,
    });
    await agent.post(`${PLANS_BASE}/${planId}/headcount`).send({
      title: 'Engineer',
      accountId: expenseAccountId,
      startsOn: '2026-10-01',
      fteCount: 2,
      annualSalaryCents: 12_000_000,
      loadingBps: 1800,
    });

    const res = await agent.get(`${PLANS_BASE}/${planId}/forecast`);
    expect(res.status).toBe(200);
    const octTotal = res.body.forecast.build.months[0].accountTotals.find(
      (t: { accountId: string }) => t.accountId === expenseAccountId,
    );
    // FIXED_CENTS 750_000 + role 2_360_000 = 3_110_000
    expect(octTotal.amountCents).toBe(3_110_000);
  });

  it('11. recomputes after a driver value changes, with nothing cached', async () => {
    const agent = await loginAgent(app, userA);
    await createProductLine(agent);
    await agent.put(`${DRIVERS_BASE}/${qtyDriverId}/values`).send({
      values: [{ month: '2026-10-01', value: 10 }],
    });
    await agent.put(`${DRIVERS_BASE}/${rateDriverId}/values`).send({
      values: [{ month: '2026-10-01', value: 100000 }],
    });

    const first = await agent.get(`${PLANS_BASE}/${planId}/forecast`);
    const firstAmount = first.body.forecast.build.months[0].lines[0].amountCents;

    await agent.put(`${DRIVERS_BASE}/${qtyDriverId}/values`).send({
      values: [{ month: '2026-10-01', value: 20 }],
    });

    const second = await agent.get(`${PLANS_BASE}/${planId}/forecast`);
    const secondAmount = second.body.forecast.build.months[0].lines[0].amountCents;

    expect(secondAmount).not.toBe(firstAmount);
    expect(secondAmount).toBe(2_000_000);
  });

  it('12. returns the org base currency on the forecast', async () => {
    const agent = await loginAgent(app, userA);
    const orgRes = await agent.get('/api/v1/organizations');
    const res = await agent.get(`${PLANS_BASE}/${planId}/forecast`);
    expect(res.status).toBe(200);
    expect(res.body.forecast.baseCurrency).toBe(orgRes.body.organization.baseCurrency);
  });

  it('13. deleting a driver used by a forecast line returns 409', async () => {
    const agent = await loginAgent(app, userA);
    await createProductLine(agent);

    const res = await agent.delete(`${DRIVERS_BASE}/${qtyDriverId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('This driver is used by a forecast line and cannot be deleted');
  });

  it('14. cross-tenant: org B plan forecast under org A token returns 404', async () => {
    const agentB = await loginAgent(app, userB);
    const planBRes = await agentB.post(PLANS_BASE).send({
      name: 'Org B Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    const planIdB = planBRes.body.plan.id;
    const revenueAccountIdB = await accountId(orgB, '4100');
    const lineRes = await agentB.post(`${PLANS_BASE}/${planIdB}/forecast-lines`).send({
      kind: 'FIXED_CENTS',
      accountId: revenueAccountIdB,
      label: 'B line',
      fixedCents: 1000,
    });
    const lineIdB = lineRes.body.line.id;
    const driverB = await agentB.post(`${PLANS_BASE}/${planIdB}/drivers`).send({
      name: 'B driver',
      unitLabel: 'x',
      kind: 'COUNT',
    });

    const agentA = await loginAgent(app, userA);

    const forecastRes = await agentA.get(`${PLANS_BASE}/${planIdB}/forecast`);
    expect(forecastRes.status).toBe(404);

    const patchRes = await agentA.patch(`${LINES_BASE}/${lineIdB}`).send({
      kind: 'FIXED_CENTS',
      accountId: revenueAccountIdB,
      label: 'Hijacked',
      fixedCents: 1,
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await agentA.delete(`${LINES_BASE}/${lineIdB}`);
    expect(deleteRes.status).toBe(404);

    // A line in org A referencing org B's driver id is refused.
    const crossLineRes = await agentA.post(`${PLANS_BASE}/${planId}/forecast-lines`).send({
      kind: 'DRIVER_PRODUCT',
      accountId: revenueAccountId,
      label: 'Cross-tenant line',
      quantityDriverId: driverB.body.driver.id,
      rateDriverId,
    });
    expect(crossLineRes.status).toBe(404);
  });

  it('15. cross-tenant: another org data never leaks into a forecast', async () => {
    const agentA = await loginAgent(app, userA);
    await createProductLine(agentA);
    await agentA.put(`${DRIVERS_BASE}/${qtyDriverId}/values`).send({
      values: [{ month: '2026-10-01', value: 10 }],
    });
    await agentA.put(`${DRIVERS_BASE}/${rateDriverId}/values`).send({
      values: [{ month: '2026-10-01', value: 100000 }],
    });

    const before = await agentA.get(`${PLANS_BASE}/${planId}/forecast`);
    const beforeAmount = before.body.forecast.build.months[0].lines[0].amountCents;

    const agentB = await loginAgent(app, userB);
    const planBRes = await agentB.post(PLANS_BASE).send({
      name: 'Org B Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    const planIdB = planBRes.body.plan.id;
    const revenueAccountIdB = await accountId(orgB, '4100');
    const qtyDriverB = await agentB.post(`${PLANS_BASE}/${planIdB}/drivers`).send({
      name: 'B customers',
      unitLabel: 'x',
      kind: 'COUNT',
    });
    const rateDriverB = await agentB.post(`${PLANS_BASE}/${planIdB}/drivers`).send({
      name: 'B rate',
      unitLabel: 'cents',
      kind: 'CENTS',
    });
    await agentB.post(`${PLANS_BASE}/${planIdB}/forecast-lines`).send({
      kind: 'DRIVER_PRODUCT',
      accountId: revenueAccountIdB,
      label: 'B line',
      quantityDriverId: qtyDriverB.body.driver.id,
      rateDriverId: rateDriverB.body.driver.id,
    });
    await agentB.put(`${DRIVERS_BASE}/${qtyDriverB.body.driver.id}/values`).send({
      values: [{ month: '2026-10-01', value: 100 }],
    });
    await agentB.put(`${DRIVERS_BASE}/${rateDriverB.body.driver.id}/values`).send({
      values: [{ month: '2026-10-01', value: 1000000 }],
    });

    const after = await agentA.get(`${PLANS_BASE}/${planId}/forecast`);
    const afterAmount = after.body.forecast.build.months[0].lines[0].amountCents;
    expect(afterAmount).toBe(beforeAmount);
  });

  it('16. a VIEWER can read a forecast', async () => {
    const viewerAgent = await loginAgent(app, userViewer);
    await switchTo(viewerAgent, orgA);
    const res = await viewerAgent.get(`${PLANS_BASE}/${planId}/forecast`);
    expect(res.status).toBe(200);
  });

  it('17. a VIEWER cannot create a forecast line', async () => {
    const viewerAgent = await loginAgent(app, userViewer);
    await switchTo(viewerAgent, orgA);
    const res = await createProductLine(viewerAgent);
    expect(res.status).toBe(403);
  });
});
