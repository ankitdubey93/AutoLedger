import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const PLANS_BASE = '/api/v1/forecaster/plans';
const VERSIONS_BASE = '/api/v1/forecaster/budget-versions';
const LINES_BASE = '/api/v1/forecaster/budget-lines';

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

describe('forecaster budget versions API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let userAccountant: SeededUser;
  let userViewer: SeededUser;
  let planId: string;
  let expenseAccountId: string;

  beforeEach(async () => {
    await resetTables();

    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;

    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });

    userAccountant = await createUserWithOrg({ label: 'ann', orgName: 'Org Ann Solo' });
    await addMember(orgA, userAccountant.id, 'ACCOUNTANT');

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
    expenseAccountId = await accountId(orgA, '6100');

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
      fteCount: 1,
      annualSalaryCents: 12_000_000,
      loadingBps: 0,
    });
  });

  afterAll(closePool);

  async function createVersion(agent: Awaited<ReturnType<typeof loginAgent>>, label = 'Q1 Budget') {
    return agent.post(`${PLANS_BASE}/${planId}/budget-versions`).send({ label });
  }

  it('1. creates a DRAFT budget version', async () => {
    const agent = await loginAgent(app, userA);
    const res = await createVersion(agent);
    expect(res.status).toBe(201);
    expect(res.body.version.status).toBe('DRAFT');
    expect(res.body.version.lineCount).toBe(0);
  });

  it('2. rejects a duplicate label on the same plan with 409', async () => {
    const agent = await loginAgent(app, userA);
    await createVersion(agent);
    const res = await createVersion(agent);
    expect(res.status).toBe(409);
  });

  it('3. compiles driver and headcount lines from the forecast', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createVersion(agent);
    const versionId = created.body.version.id;

    const res = await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);
    expect(res.status).toBe(200);
    const lines = res.body.version.lines as { source: string; justification: string }[];
    expect(lines.some((l) => l.source === 'DRIVER')).toBe(true);
    expect(lines.some((l) => l.source === 'HEADCOUNT')).toBe(true);
    expect(lines.every((l) => l.justification.length > 0)).toBe(true);
  });

  it('4. compiling twice does not double the amounts', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createVersion(agent);
    const versionId = created.body.version.id;

    const first = await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);
    const firstTotal = first.body.version.totalCents;

    const second = await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);
    const secondTotal = second.body.version.totalCents;

    expect(secondTotal).toBe(firstTotal);
  });

  it('5. compiling preserves MANUAL lines', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await createVersion(agent);
    const versionId = created.body.version.id;

    const manualRes = await agent.post(`${VERSIONS_BASE}/${versionId}/lines`).send({
      accountId: revenueAccountId,
      month: '2026-10-01',
      amountCents: 5_000_000,
      justification: 'Signed contract with Acme Corp',
    });
    expect(manualRes.status).toBe(201);

    await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);

    const getRes = await agent.get(`${VERSIONS_BASE}/${versionId}`);
    const manualLine = getRes.body.version.lines.find((l: { source: string }) => l.source === 'MANUAL');
    expect(manualLine).toBeDefined();
    expect(manualLine.amountCents).toBe(5_000_000);
  });

  it('6. refuses to approve a version with no lines with 422', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createVersion(agent);
    const versionId = created.body.version.id;

    const res = await agent.post(`${VERSIONS_BASE}/${versionId}/approve`);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('A budget version must have at least one line before approval');
  });

  it('7. approves a compiled version', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createVersion(agent);
    const versionId = created.body.version.id;
    await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);

    const res = await agent.post(`${VERSIONS_BASE}/${versionId}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.version.status).toBe('APPROVED');
    expect(res.body.version.approvedBy).not.toBeNull();
    expect(res.body.version.approvedAt).not.toBeNull();
  });

  it('8. approving a second version supersedes the first', async () => {
    const agent = await loginAgent(app, userA);
    const first = await createVersion(agent, 'V1');
    await agent.post(`${VERSIONS_BASE}/${first.body.version.id}/compile`);
    await agent.post(`${VERSIONS_BASE}/${first.body.version.id}/approve`);

    const second = await createVersion(agent, 'V2');
    await agent.post(`${VERSIONS_BASE}/${second.body.version.id}/compile`);
    const approveRes = await agent.post(`${VERSIONS_BASE}/${second.body.version.id}/approve`);
    expect(approveRes.status).toBe(200);

    const listRes = await agent.get(`${PLANS_BASE}/${planId}/budget-versions`);
    const approvedVersions = listRes.body.versions.filter((v: { status: string }) => v.status === 'APPROVED');
    expect(approvedVersions).toHaveLength(1);
    expect(approvedVersions[0].id).toBe(second.body.version.id);

    const firstGet = await agent.get(`${VERSIONS_BASE}/${first.body.version.id}`);
    expect(firstGet.body.version.status).toBe('SUPERSEDED');
  });

  it('9. refuses to edit a line on an APPROVED version with 409', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createVersion(agent);
    const versionId = created.body.version.id;
    const compiled = await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);
    await agent.post(`${VERSIONS_BASE}/${versionId}/approve`);

    const lineId = compiled.body.version.lines[0].id;
    const res = await agent.patch(`${LINES_BASE}/${lineId}`).send({ amountCents: 1 });
    expect(res.status).toBe(409);
  });

  it('10. refuses to compile an APPROVED version with 409', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createVersion(agent);
    const versionId = created.body.version.id;
    await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);
    await agent.post(`${VERSIONS_BASE}/${versionId}/approve`);

    const res = await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);
    expect(res.status).toBe(409);
  });

  it('11. refuses to delete an APPROVED version with 409', async () => {
    const agent = await loginAgent(app, userA);
    const created = await createVersion(agent);
    const versionId = created.body.version.id;
    await agent.post(`${VERSIONS_BASE}/${versionId}/compile`);
    await agent.post(`${VERSIONS_BASE}/${versionId}/approve`);

    const res = await agent.delete(`${VERSIONS_BASE}/${versionId}`);
    expect(res.status).toBe(409);
  });

  it('12. refuses a SUPERSEDED -> APPROVED transition with 409', async () => {
    const agent = await loginAgent(app, userA);
    const first = await createVersion(agent, 'V1');
    await agent.post(`${VERSIONS_BASE}/${first.body.version.id}/compile`);
    await agent.post(`${VERSIONS_BASE}/${first.body.version.id}/approve`);

    const second = await createVersion(agent, 'V2');
    await agent.post(`${VERSIONS_BASE}/${second.body.version.id}/compile`);
    await agent.post(`${VERSIONS_BASE}/${second.body.version.id}/approve`);

    const res = await agent.post(`${VERSIONS_BASE}/${first.body.version.id}/approve`);
    expect(res.status).toBe(409);
  });

  it('13. refuses a blank justification with 400', async () => {
    const agent = await loginAgent(app, userA);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await createVersion(agent);
    const versionId = created.body.version.id;

    const res = await agent.post(`${VERSIONS_BASE}/${versionId}/lines`).send({
      accountId: revenueAccountId,
      month: '2026-10-01',
      amountCents: 1000,
      justification: '   ',
    });
    expect(res.status).toBe(400);
  });

  it('14. an ACCOUNTANT cannot approve a version', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const created = await createVersion(ownerAgent);
    const versionId = created.body.version.id;
    await ownerAgent.post(`${VERSIONS_BASE}/${versionId}/compile`);

    const accountantAgent = await loginAgent(app, userAccountant);
    await switchTo(accountantAgent, orgA);
    const res = await accountantAgent.post(`${VERSIONS_BASE}/${versionId}/approve`);
    expect(res.status).toBe(403);
  });

  it('15. cross-tenant: org B version id under org A token returns 404', async () => {
    const agentB = await loginAgent(app, userB);
    const planBRes = await agentB.post(PLANS_BASE).send({
      name: 'Org B Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    const planIdB = planBRes.body.plan.id;
    const versionB = await agentB.post(`${PLANS_BASE}/${planIdB}/budget-versions`).send({ label: 'B Budget' });
    const versionIdB = versionB.body.version.id;

    const agentA = await loginAgent(app, userA);

    expect((await agentA.get(`${VERSIONS_BASE}/${versionIdB}`)).status).toBe(404);
    expect((await agentA.delete(`${VERSIONS_BASE}/${versionIdB}`)).status).toBe(404);
    expect((await agentA.post(`${VERSIONS_BASE}/${versionIdB}/compile`)).status).toBe(404);
    expect((await agentA.post(`${VERSIONS_BASE}/${versionIdB}/approve`)).status).toBe(404);

    const revenueAccountIdB = await accountId(userB.orgId, '4100');
    const linesRes = await agentA.post(`${VERSIONS_BASE}/${versionIdB}/lines`).send({
      accountId: revenueAccountIdB,
      month: '2026-10-01',
      amountCents: 1,
      justification: 'x',
    });
    expect(linesRes.status).toBe(404);
  });

  it('16. a VIEWER can read a budget version', async () => {
    const ownerAgent = await loginAgent(app, userA);
    const created = await createVersion(ownerAgent);
    const versionId = created.body.version.id;

    const viewerAgent = await loginAgent(app, userViewer);
    await switchTo(viewerAgent, orgA);
    const res = await viewerAgent.get(`${VERSIONS_BASE}/${versionId}`);
    expect(res.status).toBe(200);
  });
});
