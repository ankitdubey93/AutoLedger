import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — Profit & Loss and the balance sheet (Phase 4). Integration
 * tier, real PostgreSQL. Both reports are aggregated from raw ledger_lines
 * on every request — no summary table, same discipline as trialBalance.
 *
 * Includes this module's own cross-tenant isolation cases (rule 15).
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';
const PROFIT_AND_LOSS = '/api/v1/ledger-core/reports/profit-and-loss';
const BALANCE_SHEET = '/api/v1/ledger-core/reports/balance-sheet';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;

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

async function onboard(agent: Agent, overrides: Record<string, unknown> = {}) {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2025-01-01',
    ...overrides,
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${res.text}`);
  return res;
}

async function post(agent: Agent, orgId: string, entryDate: string, debitCode: string, creditCode: string, amountCents: number) {
  const res = await agent.post(JOURNALS).send({
    entryDate,
    description: `Fixture ${debitCode}/${creditCode}`,
    lines: [
      { accountId: await accountId(orgId, debitCode), debitCents: amountCents, creditCents: 0 },
      { accountId: await accountId(orgId, creditCode), debitCents: 0, creditCents: amountCents },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: journal post failed ${res.status} ${res.text}`);
  return res;
}

/**
 * The shared fixture: a Jan-1 fiscal year 2026, with a prior-year entry and
 * three entries inside 2026 touching revenue, COGS, and an operating expense.
 * Net cash: 500000 - 200000 - 120000 + 90000 = 270000.
 */
async function buildFixture(agent: Agent, orgId: string) {
  await post(agent, orgId, '2025-11-01', '1110', '4100', 90000); // prior fiscal year
  await post(agent, orgId, '2026-02-01', '1110', '4100', 500000); // current-year revenue
  await post(agent, orgId, '2026-02-05', '5100', '1110', 200000); // COGS
  await post(agent, orgId, '2026-03-01', '6120', '1110', 120000); // operating expense
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;

  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Charlie' });
});

afterAll(async () => {
  await closePool();
});

describe('GET /reports/profit-and-loss', () => {
  it('splits revenue, cost of sales and operating expenses for the given window', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await buildFixture(agent, orgA);

    const res = await agent.get(`${PROFIT_AND_LOSS}?from=2026-01-01&to=2026-12-31`);

    expect(res.status).toBe(200);
    expect(res.body.revenue.totalCents).toBe(500000);
    expect(res.body.costOfSales.totalCents).toBe(200000);
    expect(res.body.grossProfitCents).toBe(300000);
    expect(res.body.operatingExpenses.totalCents).toBe(120000);
    expect(res.body.netIncomeCents).toBe(180000);
  });

  it('excludes entries outside the requested window', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await buildFixture(agent, orgA);

    const res = await agent.get(`${PROFIT_AND_LOSS}?from=2026-01-01&to=2026-12-31`);

    expect(res.body.revenue.rows).toHaveLength(1);
  });

  it('defaults to the current fiscal year to date when no query params are given', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    const res = await agent.get(PROFIT_AND_LOSS);

    expect(res.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.body.to).toBe(today);
  });

  it('rejects a from after to', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    const res = await agent.get(`${PROFIT_AND_LOSS}?from=2026-12-31&to=2026-01-01`);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('from must not be after to');
  });

  it('rejects a malformed date', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    const res = await agent.get(`${PROFIT_AND_LOSS}?from=not-a-date`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('from must be a date in YYYY-MM-DD format');
  });

  it('never returns a header account', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await buildFixture(agent, orgA);

    const res = await agent.get(`${PROFIT_AND_LOSS}?from=2026-01-01&to=2026-12-31`);

    const codes = [...res.body.revenue.rows, ...res.body.costOfSales.rows, ...res.body.operatingExpenses.rows].map(
      (r: { code: string }) => r.code,
    );
    expect(codes).not.toContain('4000');
    expect(codes).not.toContain('5000');
    expect(codes).not.toContain('6000');
  });

  it('cross-tenant isolation: org B sees zero even after org A posts', async () => {
    const agentA = await loginAgent(app, userA);
    await onboard(agentA);
    await buildFixture(agentA, orgA);

    const agentB = await loginAgent(app, userC);
    await onboard(agentB);

    const res = await agentB.get(`${PROFIT_AND_LOSS}?from=2026-01-01&to=2026-12-31`);

    expect(res.status).toBe(200);
    expect(res.body.revenue.totalCents).toBe(0);
    expect(res.body.netIncomeCents).toBe(0);
    expect(res.body.revenue.rows).toHaveLength(0);
  });
});

describe('GET /reports/balance-sheet', () => {
  it('balances for a non-trivial fixture touching assets, liabilities and equity', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await buildFixture(agent, orgA);
    await post(agent, orgA, '2026-04-01', '1110', '2100', 45000);

    const res = await agent.get(`${BALANCE_SHEET}?asOf=2026-12-31`);

    expect(res.status).toBe(200);
    expect(res.body.balances).toBe(true);
    expect(res.body.liabilities.totalCents).toBe(45000);
  });

  it('computes assets and the derived earnings split', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await buildFixture(agent, orgA);

    const res = await agent.get(`${BALANCE_SHEET}?asOf=2026-12-31`);

    expect(res.body.assets.totalCents).toBe(270000);
    expect(res.body.equity.retainedEarningsCents).toBe(90000);
    expect(res.body.equity.currentEarningsCents).toBe(180000);
    expect(res.body.equity.totalCents).toBe(270000);
    expect(res.body.totalLiabilitiesAndEquityCents).toBe(270000);
  });

  it('agrees with the P&L: current-period earnings equals net income for the same window', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await buildFixture(agent, orgA);

    const pl = await agent.get(`${PROFIT_AND_LOSS}?from=2026-01-01&to=2026-12-31`);
    const bs = await agent.get(`${BALANCE_SHEET}?asOf=2026-12-31`);

    expect(pl.body.netIncomeCents).toBe(bs.body.equity.currentEarningsCents);
  });

  it('moves the fiscal-year split point with asOf', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await buildFixture(agent, orgA);

    const res = await agent.get(`${BALANCE_SHEET}?asOf=2025-12-31`);

    expect(res.body.equity.currentEarningsCents).toBe(90000);
    expect(res.body.equity.retainedEarningsCents).toBe(0);
  });

  it('rejects a malformed asOf', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    const res = await agent.get(`${BALANCE_SHEET}?asOf=nope`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('asOf must be a date in YYYY-MM-DD format');
  });

  it('confirms no summary table exists anywhere in the schema', async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public'
          AND (table_name LIKE '%balance%' OR table_name LIKE '%summary%' OR table_name LIKE '%rollup%')`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('cross-tenant isolation: org B sees a balanced, empty sheet', async () => {
    const agentA = await loginAgent(app, userA);
    await onboard(agentA);
    await buildFixture(agentA, orgA);

    const agentB = await loginAgent(app, userC);
    await onboard(agentB);

    const res = await agentB.get(`${BALANCE_SHEET}?asOf=2026-12-31`);

    expect(res.status).toBe(200);
    expect(res.body.assets.totalCents).toBe(0);
    expect(res.body.equity.retainedEarningsCents).toBe(0);
    expect(res.body.balances).toBe(true);
  });
});
