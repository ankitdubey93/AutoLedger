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
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const PAYMENTS = '/api/v1/ledger-core/payments';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';

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

describe('AR/AP blocks', () => {
  it('a fresh onboarded org has empty receivables and payables', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });

    expect(res.body.receivables.outstandingCents).toBe(0);
    expect(res.body.receivables.buckets).toHaveLength(5);
    expect(res.body.payables.outstandingCents).toBe(0);
    expect(res.body.payables.awaitingReviewCount).toBe(0);
  });

  it('an issued invoice due in the future is outstanding and not overdue', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Northwind Traders' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    const created = await agent.post(INVOICES).send({
      customerId,
      issueDate: '2026-06-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [
        { description: 'x', quantityMilli: 1000, unitPriceCents: 100000, revenueAccountId, taxRateBp: 0 },
      ],
    });
    await agent.post(`${INVOICES}/${created.body.invoice.id}/issue`).send({});

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });

    expect(res.body.receivables.outstandingCents).toBe(100000);
    expect(res.body.receivables.overdueCents).toBe(0);
    const current = res.body.receivables.buckets.find((b: { bucket: string }) => b.bucket === 'CURRENT');
    expect(current.amountCents).toBe(100000);
  });

  it('an overdue invoice moves the overdue figure', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Northwind Traders' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    const created = await agent.post(INVOICES).send({
      customerId,
      issueDate: '2026-01-01',
      dueDate: '2026-02-01',
      notes: null,
      paymentTerms: null,
      lines: [
        { description: 'x', quantityMilli: 1000, unitPriceCents: 100000, revenueAccountId, taxRateBp: 0 },
      ],
    });
    await agent.post(`${INVOICES}/${created.body.invoice.id}/issue`).send({});

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });

    expect(res.body.receivables.overdueCents).toBe(100000);
  });

  it('a draft invoice counts toward draftCount but not outstandingCents', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Northwind Traders' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    await agent.post(INVOICES).send({
      customerId,
      issueDate: '2026-06-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [
        { description: 'x', quantityMilli: 1000, unitPriceCents: 5000, revenueAccountId, taxRateBp: 0 },
      ],
    });

    const res = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });

    expect(res.body.receivables.draftCount).toBe(1);
    expect(res.body.receivables.outstandingCents).toBe(0);
  });

  it('a bill awaiting approval is not yet owed, but shows in the review queue', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const vendorRes = await agent.post(VENDORS).send({ name: 'Acme Supplies' });
    const vendorId = vendorRes.body.vendor.id as string;
    const expenseAccountId = await accountId(orgA, '6130');

    const created = await agent.post(BILLS).send({
      vendorId,
      vendorReference: 'VEND-DASH-1',
      billDate: '2026-06-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [
        { description: 'x', quantityMilli: 1000, unitPriceCents: 60000, expenseAccountId, taxRateBp: 0 },
      ],
    });
    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});

    const beforeApproval = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(beforeApproval.body.payables.awaitingReviewCount).toBe(1);
    expect(beforeApproval.body.payables.awaitingReviewCents).toBe(60000);
    expect(beforeApproval.body.payables.outstandingCents).toBe(0);

    await agent.post(`${BILLS}/${billId}/approve`).send({});

    const afterApproval = await agent.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(afterApproval.body.payables.awaitingReviewCount).toBe(0);
    expect(afterApproval.body.payables.outstandingCents).toBe(60000);

    const cashAccountId = await accountId(orgA, '1110');
    await agent.post(PAYMENTS).send({
      direction: 'PAY',
      paymentDate: '2026-06-15',
      amountCents: 60000,
      cashAccountId,
      vendorId,
      allocations: [{ invoiceId: null, billId, amountCents: 60000 }],
    });

    const afterPayment = await agent.get(DASHBOARD).query({ asOf: '2026-06-15' });
    expect(afterPayment.body.payables.outstandingCents).toBe(0);
    expect(afterPayment.body.integrity.isBalanced).toBe(true);
    expect(afterPayment.body.position.equationHolds).toBe(true);
  });

  it("never includes another org's invoices or bills", async () => {
    const agentA = await loginAgent(app, userA);
    await onboard(agentA);
    const agentC = await loginAgent(app, userC);
    await onboard(agentC);

    const customerCRes = await agentC.post(CUSTOMERS).send({ name: 'Bravo Customer' });
    const revenueAccountCId = await accountId(orgB, '4100');
    const createdC = await agentC.post(INVOICES).send({
      customerId: customerCRes.body.customer.id,
      issueDate: '2026-06-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'x',
          quantityMilli: 1000,
          unitPriceCents: 77777,
          revenueAccountId: revenueAccountCId,
          taxRateBp: 0,
        },
      ],
    });
    await agentC.post(`${INVOICES}/${createdC.body.invoice.id}/issue`).send({});

    const res = await agentA.get(DASHBOARD).query({ asOf: '2026-06-01' });
    expect(res.body.receivables.outstandingCents).toBe(0);
  });
});
