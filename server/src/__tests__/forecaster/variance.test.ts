import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const PLANS_BASE = '/api/v1/forecaster/plans';
const VERSIONS_BASE = '/api/v1/forecaster/budget-versions';
const JOURNALS = '/api/v1/ledger-core/journals';

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

describe('forecaster variance API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let orgB: string;
  let userViewer: SeededUser;
  let planId: string;
  let expenseAccountId: string;
  let revenueAccountId: string;
  let cashAccountId: string;

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
    expenseAccountId = await accountId(orgA, '6100');
    revenueAccountId = await accountId(orgA, '4100');
    cashAccountId = await accountId(orgA, '1110');
  });

  afterAll(closePool);

  async function postExpense(
    agent: Awaited<ReturnType<typeof loginAgent>>,
    accountIdForLine: string,
    amountCents: number,
    entryDate: string,
  ) {
    return agent.post(JOURNALS).send({
      entryDate,
      description: `Expense ${String(amountCents)}`,
      lines: [
        { accountId: accountIdForLine, debitCents: amountCents, creditCents: 0 },
        { accountId: cashAccountId, debitCents: 0, creditCents: amountCents },
      ],
    });
  }

  async function postRevenue(
    agent: Awaited<ReturnType<typeof loginAgent>>,
    accountIdForLine: string,
    amountCents: number,
    entryDate: string,
  ) {
    return agent.post(JOURNALS).send({
      entryDate,
      description: `Revenue ${String(amountCents)}`,
      lines: [
        { accountId: cashAccountId, debitCents: amountCents, creditCents: 0 },
        { accountId: accountIdForLine, debitCents: 0, creditCents: amountCents },
      ],
    });
  }

  async function createApprovedBudget(
    agent: Awaited<ReturnType<typeof loginAgent>>,
    accountIdForLine: string,
    amountCents: number,
    month: string,
  ) {
    const created = await agent.post(`${PLANS_BASE}/${planId}/budget-versions`).send({ label: 'Q1 Budget' });
    const versionId = created.body.version.id;
    await agent.post(`${VERSIONS_BASE}/${versionId}/lines`).send({
      accountId: accountIdForLine,
      month,
      amountCents,
      justification: 'Planned spend',
    });
    const approveRes = await agent.post(`${VERSIONS_BASE}/${versionId}/approve`);
    expect(approveRes.status).toBe(200);
    return versionId;
  }

  it('1. refuses variance with no approved budget version with 422', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(`${PLANS_BASE}/${planId}/variance`);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('This plan has no approved budget version');
  });

  it('2. reports zero variance when actuals match the budget exactly', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, expenseAccountId, 500_000, '2026-10-01');
    await postExpense(agent, expenseAccountId, 500_000, '2026-10-15');

    const res = await agent.get(`${PLANS_BASE}/${planId}/variance`);
    expect(res.status).toBe(200);
    const row = res.body.variance.rows.find((r: { accountId: string }) => r.accountId === expenseAccountId);
    expect(row.varianceCents).toBe(0);
    expect(row.favourable).toBe(true);
  });

  it('3. an expense under budget is favourable', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, expenseAccountId, 500_000, '2026-10-01');
    await postExpense(agent, expenseAccountId, 400_000, '2026-10-15');

    const res = await agent.get(`${PLANS_BASE}/${planId}/variance`);
    const row = res.body.variance.rows.find((r: { accountId: string }) => r.accountId === expenseAccountId);
    expect(row.varianceCents).toBe(-100_000);
    expect(row.favourable).toBe(true);
  });

  it('4. an expense over budget is unfavourable', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, expenseAccountId, 500_000, '2026-10-01');
    await postExpense(agent, expenseAccountId, 600_000, '2026-10-15');

    const res = await agent.get(`${PLANS_BASE}/${planId}/variance`);
    const row = res.body.variance.rows.find((r: { accountId: string }) => r.accountId === expenseAccountId);
    expect(row.varianceCents).toBe(100_000);
    expect(row.favourable).toBe(false);
  });

  it('5. revenue over budget is favourable', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, revenueAccountId, 500_000, '2026-10-01');
    await postRevenue(agent, revenueAccountId, 600_000, '2026-10-15');

    const res = await agent.get(`${PLANS_BASE}/${planId}/variance`);
    const row = res.body.variance.rows.find((r: { accountId: string }) => r.accountId === revenueAccountId);
    expect(row.favourable).toBe(true);
  });

  it('6. revenue under budget is unfavourable', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, revenueAccountId, 500_000, '2026-10-01');
    await postRevenue(agent, revenueAccountId, 400_000, '2026-10-15');

    const res = await agent.get(`${PLANS_BASE}/${planId}/variance`);
    const row = res.body.variance.rows.find((r: { accountId: string }) => r.accountId === revenueAccountId);
    expect(row.favourable).toBe(false);
  });

  it('7. an account budgeted but with no actual reports the full budget as variance', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, expenseAccountId, 500_000, '2026-10-01');

    const res = await agent.get(`${PLANS_BASE}/${planId}/variance`);
    const row = res.body.variance.rows.find((r: { accountId: string }) => r.accountId === expenseAccountId);
    expect(row).toBeDefined();
    expect(row.actualCents).toBe(0);
    expect(row.varianceCents).toBe(-500_000);
  });

  it('8. an account with an actual but no budget appears with a zero budget', async () => {
    const agent = await loginAgent(app, userA);
    // Approve a budget on a different account so there IS an approved version.
    const otherExpense = await accountId(orgA, '6110');
    await createApprovedBudget(agent, otherExpense, 100, '2026-10-01');
    await postExpense(agent, expenseAccountId, 250_000, '2026-10-15');

    const res = await agent.get(`${PLANS_BASE}/${planId}/variance`);
    const row = res.body.variance.rows.find((r: { accountId: string }) => r.accountId === expenseAccountId);
    expect(row).toBeDefined();
    expect(row.budgetCents).toBe(0);
    expect(row.actualCents).toBe(250_000);
  });

  it('9. honours the from and to query parameters', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, expenseAccountId, 100_000, '2026-10-01');

    const res = await agent.get(`${PLANS_BASE}/${planId}/variance?from=2026-11-01`);
    expect(res.status).toBe(200);
    const months = new Set(res.body.variance.rows.map((r: { month: string }) => r.month));
    expect(months.has('2026-10-01')).toBe(false);
  });

  it('10. refuses from after to with 422', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, expenseAccountId, 100_000, '2026-10-01');

    const res = await agent.get(
      `${PLANS_BASE}/${planId}/variance?from=2026-12-01&to=2026-10-01`,
    );
    expect(res.status).toBe(422);
  });

  it('11. cross-tenant: org B plan variance under org A token returns 404', async () => {
    const agentB = await loginAgent(app, userB);
    const planBRes = await agentB.post(PLANS_BASE).send({
      name: 'Org B Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    const planIdB = planBRes.body.plan.id;

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${PLANS_BASE}/${planIdB}/variance`);
    expect(res.status).toBe(404);
  });

  it('12. cross-tenant: another org postings never reach this org variance', async () => {
    const agentA = await loginAgent(app, userA);
    await createApprovedBudget(agentA, expenseAccountId, 500_000, '2026-10-01');
    await postExpense(agentA, expenseAccountId, 500_000, '2026-10-15');

    const before = await agentA.get(`${PLANS_BASE}/${planId}/variance`);
    const beforeRow = before.body.variance.rows.find(
      (r: { accountId: string }) => r.accountId === expenseAccountId,
    );

    const agentB = await loginAgent(app, userB);
    const expenseAccountIdB = await accountId(orgB, '6100');
    const cashAccountIdB = await accountId(orgB, '1110');
    await agentB.post(JOURNALS).send({
      entryDate: '2026-10-15',
      description: 'Org B expense',
      lines: [
        { accountId: expenseAccountIdB, debitCents: 5_000_000, creditCents: 0 },
        { accountId: cashAccountIdB, debitCents: 0, creditCents: 5_000_000 },
      ],
    });

    const after = await agentA.get(`${PLANS_BASE}/${planId}/variance`);
    const afterRow = after.body.variance.rows.find(
      (r: { accountId: string }) => r.accountId === expenseAccountId,
    );
    expect(afterRow.actualCents).toBe(beforeRow.actualCents);
  });

  it('13. a VIEWER can read variance', async () => {
    const ownerAgent = await loginAgent(app, userA);
    await createApprovedBudget(ownerAgent, expenseAccountId, 100_000, '2026-10-01');

    const viewerAgent = await loginAgent(app, userViewer);
    await switchTo(viewerAgent, orgA);
    const res = await viewerAgent.get(`${PLANS_BASE}/${planId}/variance`);
    expect(res.status).toBe(200);
  });
});
