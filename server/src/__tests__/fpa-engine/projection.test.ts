import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

const app = createApp();
const MODELS_BASE = '/api/v1/fpa-engine/models';
const SCENARIOS_BASE = '/api/v1/fpa-engine/scenarios';
const JOURNALS = '/api/v1/ledger-core/journals';
const BALANCE_SHEET = '/api/v1/ledger-core/reports/balance-sheet';

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

async function entry(
  orgId: string,
  debitCode: string,
  creditCode: string,
  amountCents: number,
  entryDate: string,
) {
  return {
    entryDate,
    description: `Entry ${String(amountCents)}`,
    lines: [
      { accountId: await accountId(orgId, debitCode), debitCents: amountCents, creditCents: 0 },
      { accountId: await accountId(orgId, creditCode), debitCents: 0, creditCents: amountCents },
    ],
  };
}

describe('fpa-engine projection and comparison API', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let orgA: string;
  let orgB: string;
  let userViewer: SeededUser;

  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
    orgA = userA.orgId;
    userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
    orgB = userB.orgId;
    userViewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic Solo' });
    await addMember(orgA, userViewer.id, 'VIEWER');
  });

  afterAll(closePool);

  async function seedBasicModel(agent: Awaited<ReturnType<typeof loginAgent>>, orgId: string) {
    await agent.post(JOURNALS).send(await entry(orgId, '1110', '3100', 1_000_000, '2026-08-15'));
    await agent.post(JOURNALS).send(await entry(orgId, '1120', '4100', 300_000, '2026-09-10'));

    const created = await agent.post(MODELS_BASE).send({
      name: 'FY27 Plan',
      startsOn: '2026-10-01',
      horizonMonths: 6,
      actualsThrough: '2026-09-01',
    });
    const modelId = created.body.model.id;
    const scenarioId = created.body.model.scenarios[0].id;

    const revenueAccountId = await accountId(orgId, '4100');
    await agent
      .put(`${SCENARIOS_BASE}/${scenarioId}/assumptions/${revenueAccountId}`)
      .send({ kind: 'GROWTH_BPS', growthBps: 0 });

    return { modelId, scenarioId };
  }

  it('1. end to end: a 6-month projection that balances', async () => {
    const agent = await loginAgent(app, userA);
    const { scenarioId } = await seedBasicModel(agent, orgA);

    const res = await agent.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    expect(res.status).toBe(200);
    expect(res.body.projection.months).toHaveLength(6);
    expect(res.body.projection.balances).toBe(true);
  });

  it('2. month 0\'s opening cash matches LedgerCore\'s own balance sheet', async () => {
    const agent = await loginAgent(app, userA);
    const { scenarioId } = await seedBasicModel(agent, orgA);

    const projectionRes = await agent.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    const openingCashCents = projectionRes.body.projection.months[0].cashFlow.openingCashCents;

    const sheetRes = await agent.get(`${BALANCE_SHEET}?asOf=2026-09-30`);
    expect(sheetRes.status).toBe(200);
    const cashRow = sheetRes.body.assets.rows.find((r: { code: string }) => r.code === '1110');
    expect(cashRow).toBeDefined();
    expect(openingCashCents).toBe(cashRow.amountCents);
  });

  it('3. a scenario change moves the answer', async () => {
    const agent = await loginAgent(app, userA);
    const { scenarioId } = await seedBasicModel(agent, orgA);

    const before = await agent.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    const taxBefore = before.body.projection.months[0].incomeStatement.taxCents;

    const patch = await agent.patch(`${SCENARIOS_BASE}/${scenarioId}`).send({ taxRateBps: 5000 });
    expect(patch.status).toBe(200);

    const after = await agent.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    expect(after.body.projection.months[0].incomeStatement.taxCents).toBeGreaterThan(taxBefore);
    expect(after.body.projection.balances).toBe(true);
  });

  it('4. runway responds to a burn', async () => {
    const agent = await loginAgent(app, userA);
    const { scenarioId } = await seedBasicModel(agent, orgA);

    const expenseAccountId = await accountId(orgA, '6100');
    await agent
      .put(`${SCENARIOS_BASE}/${scenarioId}/assumptions/${expenseAccountId}`)
      .send({ kind: 'FIXED_CENTS', fixedCents: 1_000_000 });

    const res = await agent.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    expect(typeof res.body.projection.runwayMonths).toBe('number');
    const months: { month: string }[] = res.body.projection.months;
    expect(months.map((m) => m.month)).toContain(res.body.projection.cashOutMonth);
  });

  it('5. comparison covers every scenario, default first', async () => {
    const agent = await loginAgent(app, userA);
    const { modelId } = await seedBasicModel(agent, orgA);

    await agent.post(`${MODELS_BASE}/${modelId}/scenarios`).send({
      name: 'Downside',
      kind: 'DOWNSIDE',
      dsoDays: 0,
      dpoDays: 0,
      taxRateBps: 0,
    });

    const res = await agent.get(`${MODELS_BASE}/${modelId}/comparison`);
    expect(res.status).toBe(200);
    expect(res.body.scenarios).toHaveLength(2);
    expect(res.body.scenarios[0].isDefault).toBe(true);
    for (const scenario of res.body.scenarios) {
      expect(scenario.balances).toBe(true);
    }
  });

  it('6. cross-tenant projection GET returns 404', async () => {
    const agentB = await loginAgent(app, userB);
    const { scenarioId } = await seedBasicModel(agentB, orgB);

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    expect(res.status).toBe(404);
  });

  it('7. cross-tenant comparison GET returns 404', async () => {
    const agentB = await loginAgent(app, userB);
    const { modelId } = await seedBasicModel(agentB, orgB);

    const agentA = await loginAgent(app, userA);
    const res = await agentA.get(`${MODELS_BASE}/${modelId}/comparison`);
    expect(res.status).toBe(404);
  });

  it('8. cross-tenant actuals do not leak into the projection', async () => {
    const agentA = await loginAgent(app, userA);
    const { scenarioId } = await seedBasicModel(agentA, orgA);

    const agentB = await loginAgent(app, userB);
    await agentB.post(JOURNALS).send(await entry(orgB, '1120', '4100', 3_000_000, '2026-09-10'));

    const res = await agentA.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    expect(res.body.projection.months[0].incomeStatement.revenueCents).toBe(300000);
  });

  it('9. a VIEWER can read the projection', async () => {
    const owner = await loginAgent(app, userA);
    const { scenarioId } = await seedBasicModel(owner, orgA);

    const viewer = await loginAgent(app, userViewer);
    await switchTo(viewer, orgA);
    const res = await viewer.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    expect(res.status).toBe(200);
  });

  it('10. a model with no actuals still projects at zero and balances', async () => {
    const agent = await loginAgent(app, userA);
    const created = await agent.post(MODELS_BASE).send({
      name: 'Empty Plan',
      startsOn: '2026-10-01',
      horizonMonths: 3,
      actualsThrough: '2026-09-01',
    });
    const scenarioId = created.body.model.scenarios[0].id;

    const res = await agent.get(`${SCENARIOS_BASE}/${scenarioId}/projection`);
    expect(res.status).toBe(200);
    for (const month of res.body.projection.months) {
      expect(month.incomeStatement.revenueCents).toBe(0);
    }
    expect(res.body.projection.months[0].cashFlow.openingCashCents).toBe(0);
    expect(res.body.projection.balances).toBe(true);
  });

  it('11. ROLLBACK path: a rolled-back insert never appears in the list', async () => {
    const client = await pool.connect();
    try {
      await beginTransaction(client);
      await client.query(
        `INSERT INTO fpa_models (org_id, name, starts_on, horizon_months, actuals_through, created_by)
         VALUES ($1, 'Rolled Back', '2026-10-01', 12, '2026-09-01', $2)`,
        [orgA, userA.id],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const agent = await loginAgent(app, userA);
    const res = await agent.get(MODELS_BASE);
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.models.some((m: { name: string }) => m.name === 'Rolled Back')).toBe(false);
  });
});
