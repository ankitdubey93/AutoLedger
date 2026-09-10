import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — period-end unrealized FX revaluation (Phase 8). Integration
 * tier, real PostgreSQL. Includes this module's own cross-tenant isolation
 * case.
 *
 * Fixture: org base INR; a $1,000.00 USD invoice issued 2026-01-05 at
 * rate 83.00; rates USD -> INR 83.00 on 2026-01-01 and 84.00 on 2026-01-31.
 */

const app = createApp();
const ORGANIZATIONS = '/api/v1/organizations';
const RATES = '/api/v1/ledger-core/fx-rates';
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const PAYMENTS = '/api/v1/ledger-core/payments';
const REVALUATIONS = '/api/v1/ledger-core/fx-revaluations';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const JOURNALS = '/api/v1/ledger-core/journals';
const REPORTS = '/api/v1/ledger-core/reports';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';

let userA: SeededUser;
let userB: SeededUser;
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

async function setUpFxFixture(agent: Agent): Promise<void> {
  const patched = await agent.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
  if (patched.status !== 200) throw new Error(`fixture: baseCurrency patch failed ${patched.status}`);
  await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });
  await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-31', rate: '84.00000000' });
}

async function issueUsdInvoice(
  agent: Agent,
  customerId: string,
  revenueAccountId: string,
  amountCents = 100000,
  issueDate = '2026-01-05',
): Promise<string> {
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: '2026-06-01',
    currencyCode: 'USD',
    notes: null,
    paymentTerms: null,
    lines: [{ description: 'Consulting', quantityMilli: 1000, unitPriceCents: amountCents, revenueAccountId, taxRateBp: 0 }],
  });
  const invoiceId = created.body.invoice.id as string;
  const issued = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: issue failed ${issued.status} ${issued.text}`);
  return invoiceId;
}

async function approveUsdBill(
  agent: Agent,
  vendorId: string,
  expenseAccountId: string,
  amountCents = 100000,
  billDate = '2026-01-05',
): Promise<string> {
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: `FX-${Math.random().toString(36).slice(2, 8)}`,
    billDate,
    dueDate: '2026-06-01',
    currencyCode: 'USD',
    notes: null,
    paymentTerms: null,
    lines: [{ description: 'Cloud hosting', quantityMilli: 1000, unitPriceCents: amountCents, expenseAccountId, taxRateBp: 0 }],
  });
  const billId = created.body.bill.id as string;
  await agent.post(`${BILLS}/${billId}/submit`).send({});
  const approved = await agent.post(`${BILLS}/${billId}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: approve failed ${approved.status} ${approved.text}`);
  return billId;
}

async function linesFor(agent: Agent, journalEntryId: string) {
  const res = await agent.get(`${JOURNALS}/${journalEntryId}`);
  return res.body.entry.lines as {
    accountCode: string;
    debitCents: number;
    creditCents: number;
  }[];
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(closePool);

describe('GET /reports/fx-exposure', () => {
  it('shows the unrealized delta without posting anything', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    await issueUsdInvoice(agent, customerId, revenueAccountId);

    const before = await pool.query<{ n: string }>('SELECT count(*) AS n FROM journal_entries WHERE org_id = $1', [orgA]);

    const res = await agent.get(`${REPORTS}/fx-exposure`).query({ asOf: '2026-01-31' });

    expect(res.status).toBe(200);
    expect(res.body.exposure.documents).toHaveLength(1);
    expect(res.body.exposure.documents[0]).toMatchObject({
      carryingBaseCents: 8300000,
      revaluedBaseCents: 8400000,
      deltaCents: 100000,
    });
    expect(res.body.exposure.totalDeltaCents).toBe(100000);
    expect(res.body.exposure.alreadyRevalued).toBe(false);

    const after = await pool.query<{ n: string }>('SELECT count(*) AS n FROM journal_entries WHERE org_id = $1', [orgA]);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('a base-currency-only organization has nothing to revalue', async () => {
    const agent = await loginAgent(app, userA);
    // No setUpFxFixture — org stays at the USD default, no foreign documents.

    const res = await agent.get(`${REPORTS}/fx-exposure`).query({ asOf: '2026-01-31' });

    expect(res.status).toBe(200);
    expect(res.body.exposure.documents).toEqual([]);
    expect(res.body.exposure.totalDeltaCents).toBe(0);
  });
});

describe('POST /fx-revaluations', () => {
  it('posts an entry and an automatic next-day reversal', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    await issueUsdInvoice(agent, customerId, revenueAccountId);

    const res = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });

    expect(res.status).toBe(201);
    expect(res.body.revaluation.totalDeltaCents).toBe(100000);
    expect(res.body.revaluation.lineCount).toBe(1);

    const entryRes = await agent.get(`${JOURNALS}/${res.body.revaluation.journalEntryId}`);
    expect(entryRes.body.entry.entryDate).toBe('2026-01-31');
    const lines = await linesFor(agent, res.body.revaluation.journalEntryId);
    const receivable = lines.find((l) => l.accountCode === '1120');
    expect(receivable).toMatchObject({ debitCents: 100000 });
    const unrealized = lines.find((l) => l.accountCode === '6820');
    expect(unrealized).toMatchObject({ creditCents: 100000 });

    const reversalRes = await agent.get(`${JOURNALS}/${res.body.revaluation.reversalJournalEntryId}`);
    expect(reversalRes.body.entry.entryDate).toBe('2026-02-01');
    expect(reversalRes.body.entry.reversesEntryId).toBe(res.body.revaluation.journalEntryId);
  });

  it('a payable revalues in the opposite direction', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const vendorRes = await agent.post(VENDORS).send({ name: 'Global Supplies' });
    const vendorId = vendorRes.body.vendor.id as string;
    const expenseAccountId = await accountId(orgA, '6120');
    await approveUsdBill(agent, vendorId, expenseAccountId);

    const res = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });

    expect(res.status).toBe(201);
    const lines = await linesFor(agent, res.body.revaluation.journalEntryId);
    const payable = lines.find((l) => l.accountCode === '2100');
    expect(payable).toMatchObject({ creditCents: 100000 });
    const unrealized = lines.find((l) => l.accountCode === '6820');
    expect(unrealized).toMatchObject({ debitCents: 100000 });
  });

  it('a settled document is not revalued', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    const invoiceId = await issueUsdInvoice(agent, customerId, revenueAccountId);
    const cashAccountId = await accountId(orgA, '1110');

    await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-20',
      amountCents: 100000,
      currencyCode: 'USD',
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 100000 }],
    });

    const res = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('no open foreign-currency balance');
  });

  it('a partially settled document revalues only the outstanding portion', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    const invoiceId = await issueUsdInvoice(agent, customerId, revenueAccountId);
    const cashAccountId = await accountId(orgA, '1110');

    await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-20',
      amountCents: 40000,
      currencyCode: 'USD',
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 40000 }],
    });

    const res = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });

    expect(res.status).toBe(201);
    // outstanding 60000 cents: carrying 60000*83.00=4,980,000; revalued 60000*84.00=5,040,000; delta 60,000
    expect(res.body.revaluation.totalDeltaCents).toBe(60000);
  });

  it('is refused a second time for the same date', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    await issueUsdInvoice(agent, customerId, revenueAccountId);

    const first = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });
    expect(first.status).toBe(201);

    const second = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });
    expect(second.status).toBe(409);
  });

  it('a base-currency-only organization has nothing to revalue', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });
    expect(res.status).toBe(422);
  });

  it('the balance sheet still balances after a revaluation', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    await issueUsdInvoice(agent, customerId, revenueAccountId);

    const posted = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });
    expect(posted.status).toBe(201);

    const balanceSheet = await agent.get(`${REPORTS}/balance-sheet`).query({ asOf: '2026-01-31' });
    expect(balanceSheet.body.assets.totalCents).toBe(balanceSheet.body.totalLiabilitiesAndEquityCents);
  });

  it('emits fx.revaluation_posted on the same transaction', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    await issueUsdInvoice(agent, customerId, revenueAccountId);

    const posted = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });
    expect(posted.status).toBe(201);

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE org_id = $1 AND event_type = 'fx.revaluation_posted'`,
      [orgA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.revaluationId).toBe(posted.body.revaluation.id);
  });

  it('revaluing into a period whose next day is closed is refused, and writes nothing', async () => {
    const agent = await loginAgent(app, userA);

    const onboarded = await agent.post(ONBOARDING).send({
      organizationName: 'Acme Books',
      baseCurrency: 'INR',
      fiscalYearStartMonth: 1,
      booksStartDate: '2026-01-01',
    });
    expect(onboarded.status).toBe(200);
    await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });
    await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-31', rate: '84.00000000' });

    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    await issueUsdInvoice(agent, customerId, revenueAccountId);

    const generated = await agent.post(`${PERIODS}/generate`).send({ containingDate: '2026-01-15' });
    expect(generated.status).toBe(201);
    const februaryId = generated.body.periods[1].id as string;
    const closedFebruary = await agent.post(`${PERIODS}/${februaryId}/close`).send({});
    expect(closedFebruary.status).toBe(200);

    const revalCountBefore = await pool.query<{ n: string }>('SELECT count(*) AS n FROM fx_revaluations WHERE org_id = $1', [orgA]);

    const res = await agent.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });

    expect(res.status).toBe(422);
    const revalCountAfter = await pool.query<{ n: string }>('SELECT count(*) AS n FROM fx_revaluations WHERE org_id = $1', [orgA]);
    expect(revalCountAfter.rows[0]?.n).toBe(revalCountBefore.rows[0]?.n);
  });
});

describe('cross-tenant isolation', () => {
  it("org B cannot read org A's revaluation, and org A's exposure never lists org B's documents", async () => {
    const agentA = await loginAgent(app, userA);
    await setUpFxFixture(agentA);
    const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    await issueUsdInvoice(agentA, customerId, revenueAccountId);
    const posted = await agentA.post(REVALUATIONS).send({ asOfDate: '2026-01-31' });
    const revaluationId = posted.body.revaluation.id as string;

    const agentB = await loginAgent(app, userB);
    const getFromB = await agentB.get(`${REVALUATIONS}/${revaluationId}`);
    expect(getFromB.status).toBe(404);

    const exposureB = await agentB.get(`${REPORTS}/fx-exposure`).query({ asOf: '2026-01-31' });
    expect(exposureB.body.exposure.documents).toEqual([]);

    const gainAccountB = await accountId(userB.orgId, '6820');
    const { rows } = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(base_credit_cents - base_debit_cents), 0)::text AS balance
         FROM ledger_lines WHERE org_id = $1 AND account_id = $2`,
      [userB.orgId, gainAccountB],
    );
    expect(rows[0]?.balance).toBe('0');
  });
});
