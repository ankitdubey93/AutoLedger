import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * BoardDeck budget-vs-actual (Phase 15). Integration tier, real PostgreSQL.
 * Includes this module's own cross-tenant isolation suite (rule 15). Fixture
 * mirrors forecaster/variance.test.ts's shape.
 */

const app = createApp();
const BVA = '/api/v1/boarddeck/bva';
const PLANS_BASE = '/api/v1/forecaster/plans';
const VERSIONS_BASE = '/api/v1/forecaster/budget-versions';
const JOURNALS = '/api/v1/ledger-core/journals';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let planId: string;
let expenseAccountId: string;
let revenueAccountId: string;
let cogsAccountId: string;
let cashAccountId: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE org_id = $1 AND code = $2', [
    orgId,
    code,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

async function postExpense(agent: Agent, accountIdForLine: string, amountCents: number, entryDate: string) {
  return agent.post(JOURNALS).send({
    entryDate,
    description: `Expense ${String(amountCents)}`,
    lines: [
      { accountId: accountIdForLine, debitCents: amountCents, creditCents: 0 },
      { accountId: cashAccountId, debitCents: 0, creditCents: amountCents },
    ],
  });
}

async function postRevenue(agent: Agent, accountIdForLine: string, amountCents: number, entryDate: string) {
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
  agent: Agent,
  targetPlanId: string,
  accountIdForLine: string,
  amountCents: number,
  month: string,
) {
  const created = await agent.post(`${PLANS_BASE}/${targetPlanId}/budget-versions`).send({ label: `Budget ${month}-${accountIdForLine}` });
  const versionId = created.body.version.id as string;
  await agent.post(`${VERSIONS_BASE}/${versionId}/lines`).send({
    accountId: accountIdForLine,
    month,
    amountCents,
    justification: 'Planned spend',
  });
  const approveRes = await agent.post(`${VERSIONS_BASE}/${versionId}/approve`);
  if (approveRes.status !== 200) throw new Error(`fixture: approve failed ${approveRes.status} ${JSON.stringify(approveRes.body)}`);
  return versionId;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgB = userB.orgId;

  const agent = await loginAgent(app, userA);
  const createdPlan = await agent.post(PLANS_BASE).send({
    name: 'FY27 Plan',
    startsOn: '2026-10-01',
    horizonMonths: 3,
    actualsThrough: '2026-09-01',
  });
  planId = createdPlan.body.plan.id as string;
  expenseAccountId = await accountId(orgA, '6100');
  revenueAccountId = await accountId(orgA, '4100');
  cogsAccountId = await accountId(orgA, '5100');
  cashAccountId = await accountId(orgA, '1110');
});

afterAll(closePool);

describe('BoardDeck BvA API', () => {
  it('GET /bva returns four sections and drivers for an approved plan', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, planId, expenseAccountId, 500_000, '2026-10-01');
    await postExpense(agent, expenseAccountId, 400_000, '2026-10-15');

    const res = await agent.get(BVA).query({ planId });
    expect(res.status).toBe(200);
    expect(res.body.bva.summary.sections).toHaveLength(4);
    expect(res.body.bva.summary.sections.map((s: { section: string }) => s.section)).toEqual([
      'Revenue',
      'Cost of Sales',
      'Operating Expenses',
      'Other',
    ]);
  });

  it('section variances sum to the total against real posted actuals', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, planId, revenueAccountId, 1_000_000, '2026-10-01');
    await createApprovedBudget(agent, planId, cogsAccountId, 300_000, '2026-10-01');
    await createApprovedBudget(agent, planId, expenseAccountId, 200_000, '2026-10-01');
    await postRevenue(agent, revenueAccountId, 1_100_000, '2026-10-15');
    await postExpense(agent, cogsAccountId, 250_000, '2026-10-16');
    await postExpense(agent, expenseAccountId, 210_000, '2026-10-17');

    const res = await agent.get(BVA).query({ planId });
    expect(res.status).toBe(200);
    const sum = (res.body.bva.summary.sections as { varianceCents: number }[]).reduce(
      (acc, s) => acc + s.varianceCents,
      0,
    );
    expect(sum).toBe(res.body.bva.summary.totalVarianceCents);
  });

  it('a plan with no approved budget version returns 422', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BVA).query({ planId });
    expect(res.status).toBe(422);
  });

  it('an unknown planId returns 404', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(BVA).query({ planId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });

  it('topN=1 returns exactly one driver', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, planId, expenseAccountId, 100_000, '2026-10-01');
    const otherExpense = await accountId(orgA, '6110');
    await createApprovedBudget(agent, planId, otherExpense, 200_000, '2026-10-01');
    await postExpense(agent, expenseAccountId, 90_000, '2026-10-15');
    await postExpense(agent, otherExpense, 500_000, '2026-10-16');

    const res = await agent.get(BVA).query({ planId, topN: '1' });
    expect(res.status).toBe(200);
    expect(res.body.bva.summary.drivers).toHaveLength(1);
  });

  it('topN=0 returns 400', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, planId, expenseAccountId, 100_000, '2026-10-01');
    const res = await agent.get(BVA).query({ planId, topN: '0' });
    expect(res.status).toBe(400);
  });

  it('a malformed from returns 400', async () => {
    const agent = await loginAgent(app, userA);
    await createApprovedBudget(agent, planId, expenseAccountId, 100_000, '2026-10-01');
    const res = await agent.get(BVA).query({ planId, from: '2026-03-15' });
    expect(res.status).toBe(400);
  });

  it("GET /bva with org B's planId under org A's token returns 404", async () => {
    const agentB = await loginAgent(app, userB);
    const planBRes = await agentB.post(PLANS_BASE).send({
      name: 'Org B Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    const planIdB = planBRes.body.plan.id as string;

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(BVA).query({ planId: planIdB });
    expect(res.status).toBe(404);
  });

  it('org B posting 100x the actuals in the same window leaves org A totals unchanged to the cent', async () => {
    const agentA = await loginAgent(app, userA);
    await createApprovedBudget(agentA, planId, expenseAccountId, 500_000, '2026-10-01');
    await postExpense(agentA, expenseAccountId, 400_000, '2026-10-15');

    const before = await agentA.get(BVA).query({ planId });

    const agentB = await loginAgent(app, userB);
    const planBRes = await agentB.post(PLANS_BASE).send({
      name: 'Org B Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    const planIdB = planBRes.body.plan.id as string;
    const expenseAccountIdB = await accountId(orgB, '6100');
    const cashAccountIdB = await accountId(orgB, '1110');
    await agentB.post(`${PLANS_BASE}/${planIdB}/budget-versions`).send({ label: 'B budget' }).then(async (created) => {
      const versionId = created.body.version.id as string;
      await agentB.post(`${VERSIONS_BASE}/${versionId}/lines`).send({
        accountId: expenseAccountIdB,
        month: '2026-10-01',
        amountCents: 50_000_000,
        justification: 'Org B',
      });
      await agentB.post(`${VERSIONS_BASE}/${versionId}/approve`);
    });
    await agentB.post(JOURNALS).send({
      entryDate: '2026-10-15',
      description: 'Org B expense',
      lines: [
        { accountId: expenseAccountIdB, debitCents: 40_000_000, creditCents: 0 },
        { accountId: cashAccountIdB, debitCents: 0, creditCents: 40_000_000 },
      ],
    });

    const after = await agentA.get(BVA).query({ planId });
    expect(after.body.bva.summary.totalActualCents).toBe(before.body.bva.summary.totalActualCents);
    expect(after.body.bva.summary.totalBudgetCents).toBe(before.body.bva.summary.totalBudgetCents);
  });
});
