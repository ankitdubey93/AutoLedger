import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — the dashboard. Integration tier, real PostgreSQL.
 *
 * Computed from raw ledger lines on every request, exactly like
 * reportService.trialBalance — there is no summary table anywhere in the
 * schema (see settings.test.ts's sibling assertion in reports.test.ts).
 */

const app = createApp();
const JOURNALS = '/api/v1/ledger-core/journals';
const DASHBOARD = '/api/v1/ledger-core/reports/dashboard';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';

let userA: SeededUser;
let userB: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

/** A revenue sale: debit cash (1110), credit product revenue (4100). */
async function sale(orgId: string, amountCents: number, entryDate = '2026-06-01') {
  return {
    entryDate,
    description: `Sale ${String(amountCents)}`,
    lines: [
      { accountId: await accountId(orgId, '1110'), debitCents: amountCents, creditCents: 0 },
      { accountId: await accountId(orgId, '4100'), debitCents: 0, creditCents: amountCents },
    ],
  };
}

type Agent = Awaited<ReturnType<typeof loginAgent>>;

async function onboard(agent: Agent, overrides: Record<string, unknown> = {}) {
  const res = await agent.post(ONBOARDING).send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
    ...overrides,
  });
  if (res.status !== 200) throw new Error(`fixture: onboarding failed ${res.status} ${res.text}`);
  return res;
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bobs Own' });
  await addMember(orgA, userB.id, 'ADMIN');
  await addMember(orgB, userB.id, 'ADMIN');
});

afterAll(closePool);

describe('a fresh organization with no postings', () => {
  it('reports every tile at zero, a 6-point trend, and balanced integrity', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(DASHBOARD);

    expect(res.status).toBe(200);
    expect(res.body.position.assetsCents).toBe(0);
    expect(res.body.position.liabilitiesCents).toBe(0);
    expect(res.body.position.equityCents).toBe(0);
    expect(res.body.performance.yearToDate.revenueCents).toBe(0);
    expect(res.body.trend).toHaveLength(6);
    expect(res.body.integrity.isBalanced).toBe(true);
  });
});

describe('fiscal-year windowing', () => {
  it('year-to-date includes only entries inside the configured fiscal year', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent, { fiscalYearStartMonth: 4, booksStartDate: '2026-01-01' });

    // FY starting April 2026, evaluated at 2026-06-01, runs 2026-04-01..2027-03-31.
    await agent.post(JOURNALS).send(await sale(orgA, 30000, '2026-03-01')); // previous FY
    await agent.post(JOURNALS).send(await sale(orgA, 50000, '2026-05-01')); // inside FY

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });

    expect(res.status).toBe(200);
    expect(res.body.fiscalYear.startDate).toBe('2026-04-01');
    expect(res.body.performance.yearToDate.revenueCents).toBe(50000);
  });
});

describe('a single balanced posting', () => {
  it('moves the asset tile, year-to-date revenue and net income together', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await agent.post(JOURNALS).send(await sale(orgA, 100000, '2026-06-01'));

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });

    expect(res.body.position.assetsCents).toBe(100000);
    expect(res.body.performance.yearToDate.revenueCents).toBe(100000);
    expect(res.body.performance.yearToDate.netIncomeCents).toBe(100000);
  });

  it('satisfies assets = liabilities + equity + current earnings', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await agent.post(JOURNALS).send(await sale(orgA, 100000, '2026-06-01'));

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(res.body.position.equationHolds).toBe(true);
  });

  it('keeps total debits equal to total credits', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await agent.post(JOURNALS).send(await sale(orgA, 100000, '2026-06-01'));

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(res.body.integrity.totalDebitCents).toBe(res.body.integrity.totalCreditCents);
    expect(res.body.integrity.isBalanced).toBe(true);
  });
});

describe('the cash tile', () => {
  it('is null when no cash account is configured', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await agent.post(JOURNALS).send(await sale(orgA, 100000, '2026-06-01'));

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(res.body.position.cashCents).toBeNull();
  });

  it('sums the whole subtree when configured to a header account', async () => {
    const agent = await loginAgent(app, userA);
    const currentAssetsHeader = await accountId(orgA, '1100'); // parent of 1110, 1120, 1130, 1140, 1180
    await onboard(agent, { cashAccountId: currentAssetsHeader });

    await agent.post(JOURNALS).send(await sale(orgA, 100000, '2026-06-01'));

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(res.body.position.cashCents).toBe(100000);
  });
});

describe('the trend', () => {
  it('gap-fills empty months rather than omitting them', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    // The 6-month window ending in June 2026 is Jan-Jun 2026. Post only in
    // the first and last months.
    await agent.post(JOURNALS).send(await sale(orgA, 10000, '2026-01-15'));
    await agent.post(JOURNALS).send(await sale(orgA, 20000, '2026-06-01'));

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });

    expect(res.body.trend).toHaveLength(6);
    const byMonth = new Map(
      res.body.trend.map((p: { month: string; revenueCents: number }) => [p.month, p.revenueCents]),
    );
    expect(byMonth.get('2026-01')).toBe(10000);
    expect(byMonth.get('2026-06')).toBe(20000);
    expect(byMonth.get('2026-02')).toBe(0);
    expect(byMonth.get('2026-03')).toBe(0);
    expect(byMonth.get('2026-04')).toBe(0);
    expect(byMonth.get('2026-05')).toBe(0);
  });
});

describe('?asOf', () => {
  it('excludes a posting dated after the cutoff', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    await agent.post(JOURNALS).send(await sale(orgA, 100000, '2026-06-01'));

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-05-01' });
    expect(res.body.position.assetsCents).toBe(0);
  });

  it('rejects a malformed date', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(DASHBOARD).query({ asOf: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});

describe('access', () => {
  it('a VIEWER can read the dashboard', async () => {
    const viewer = await createUserWithOrg({ label: 'vic', orgName: 'Org Vic' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.get(DASHBOARD);
    expect(res.status).toBe(200);
  });
});

describe('cross-tenant isolation', () => {
  it("org A's dashboard never includes org B's postings", async () => {
    const agentC = await loginAgent(app, userC);
    await agentC.post(JOURNALS).send(await sale(orgB, 99999, '2026-06-01'));

    const agentA = await loginAgent(app, userA);
    await agentA.post(JOURNALS).send(await sale(orgA, 10000, '2026-06-01'));

    const res = await agentA.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(res.body.position.assetsCents).toBe(10000);
    expect(res.body.integrity.totalDebitCents).toBe(10000);
  });

  it('a forged orgId in the query string, headers and body is ignored', async () => {
    const agentA = await loginAgent(app, userA);
    await agentA.post(JOURNALS).send(await sale(orgA, 10000, '2026-06-01'));

    const honest = await agentA.get(DASHBOARD).query({ asOf: '2026-06-01' });
    const forged = await agentA
      .get(DASHBOARD)
      .query({ asOf: '2026-06-01', orgId: orgB })
      .set('X-Org-Id', orgB)
      .send({ orgId: orgB });

    expect(forged.status).toBe(200);
    expect(forged.body).toEqual(honest.body);
    expect(forged.text).toBe(honest.text);
  });

  it('a user in both tenants sees a different dashboard in each', async () => {
    const agentB = await loginAgent(app, userB);

    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    await agentB.post(JOURNALS).send(await sale(orgA, 15000, '2026-06-01'));

    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgB });
    await agentB.post(JOURNALS).send(await sale(orgB, 25000, '2026-06-01'));

    const inB = await agentB.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(inB.body.position.assetsCents).toBe(25000);

    await agentB.post('/api/v1/auth/switch-org').send({ orgId: orgA });
    const inA = await agentB.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(inA.body.position.assetsCents).toBe(15000);
  });
});
