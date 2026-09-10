import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — realized FX on settlement (Phase 8). Integration tier, real
 * PostgreSQL. Includes this module's own cross-tenant isolation case.
 *
 * Fixture: org A's base currency is INR; USD -> INR rates 83.00 on
 * 2026-01-01 and 83.50 on 2026-01-10 (the worked example in
 * docs/ledger-core.md's dates).
 */

const app = createApp();
const ORGANIZATIONS = '/api/v1/organizations';
const RATES = '/api/v1/ledger-core/fx-rates';
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const PAYMENTS = '/api/v1/ledger-core/payments';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const JOURNALS = '/api/v1/ledger-core/journals';
const REPORTS = '/api/v1/ledger-core/reports';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let cashAccountId: string;

type Agent = Awaited<ReturnType<typeof loginAgent>>;
type GlLine = {
  accountCode: string;
  debitCents: number;
  creditCents: number;
  currencyCode: string;
  fxRate: string;
  baseDebitCents: number;
  baseCreditCents: number;
};

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
  await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-10', rate: '83.50000000' });
}

async function issueUsdInvoice(
  agent: Agent,
  customerId: string,
  revenueAccountId: string,
  amountCents = 100000,
  issueDate = '2026-01-01',
): Promise<string> {
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: '2026-06-01',
    currencyCode: 'USD',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Consulting',
        quantityMilli: 1000,
        unitPriceCents: amountCents,
        revenueAccountId,
        taxRateBp: 0,
      },
    ],
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
  billDate = '2026-01-01',
): Promise<string> {
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: `FX-${Math.random().toString(36).slice(2, 8)}`,
    billDate,
    dueDate: '2026-06-01',
    currencyCode: 'USD',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Cloud hosting',
        quantityMilli: 1000,
        unitPriceCents: amountCents,
        expenseAccountId,
        taxRateBp: 0,
      },
    ],
  });
  const billId = created.body.bill.id as string;
  await agent.post(`${BILLS}/${billId}/submit`).send({});
  const approved = await agent.post(`${BILLS}/${billId}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: approve failed ${approved.status} ${approved.text}`);
  return billId;
}

async function linesFor(agent: Agent, journalEntryId: string): Promise<GlLine[]> {
  const res = await agent.get(`${JOURNALS}/${journalEntryId}`);
  return res.body.entry.lines as GlLine[];
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(closePool);

describe('realized FX on settlement', () => {
  it('reproduces docs/ledger-core.md\'s worked example to the paisa', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    cashAccountId = await accountId(orgA, '1110');
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    const invoiceId = await issueUsdInvoice(agent, customerId, revenueAccountId);

    const payment = await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-10',
      amountCents: 100000,
      currencyCode: 'USD',
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 100000 }],
    });
    expect(payment.status).toBe(201);

    const lines = await linesFor(agent, payment.body.payment.journalEntryId);
    expect(lines).toHaveLength(3);

    const cash = lines.find((l) => l.accountCode === '1110');
    expect(cash).toMatchObject({ currencyCode: 'USD', debitCents: 100000, fxRate: '83.50000000', baseDebitCents: 8350000 });

    const receivable = lines.find((l) => l.accountCode === '1120');
    expect(receivable).toMatchObject({ currencyCode: 'USD', creditCents: 100000, fxRate: '83.00000000', baseCreditCents: 8300000 });

    const gain = lines.find((l) => l.accountCode === '4910');
    expect(gain).toMatchObject({ currencyCode: 'INR', creditCents: 50000, fxRate: '1.00000000', baseCreditCents: 50000 });
  });

  it('the mirror case — a payable settled high is a loss', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    cashAccountId = await accountId(orgA, '1110');
    const vendorRes = await agent.post(VENDORS).send({ name: 'Global Supplies' });
    const vendorId = vendorRes.body.vendor.id as string;
    const expenseAccountId = await accountId(orgA, '6120');

    const billId = await approveUsdBill(agent, vendorId, expenseAccountId);

    const payment = await agent.post(PAYMENTS).send({
      direction: 'PAY',
      paymentDate: '2026-01-10',
      amountCents: 100000,
      currencyCode: 'USD',
      cashAccountId,
      vendorId,
      allocations: [{ invoiceId: null, billId, amountCents: 100000 }],
    });
    expect(payment.status).toBe(201);

    const lines = await linesFor(agent, payment.body.payment.journalEntryId);
    expect(lines).toHaveLength(3);

    const payable = lines.find((l) => l.accountCode === '2100');
    expect(payable).toMatchObject({ currencyCode: 'USD', debitCents: 100000, fxRate: '83.00000000', baseDebitCents: 8300000 });

    const cash = lines.find((l) => l.accountCode === '1110');
    expect(cash).toMatchObject({ currencyCode: 'USD', creditCents: 100000, fxRate: '83.50000000', baseCreditCents: 8350000 });

    const loss = lines.find((l) => l.accountCode === '6810');
    expect(loss).toMatchObject({ currencyCode: 'INR', debitCents: 50000, fxRate: '1.00000000', baseDebitCents: 50000 });
  });

  it('a settlement at the same rate posts no FX line', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    cashAccountId = await accountId(orgA, '1110');
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    const invoiceId = await issueUsdInvoice(agent, customerId, revenueAccountId);

    const payment = await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-05',
      amountCents: 100000,
      currencyCode: 'USD',
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 100000 }],
    });
    expect(payment.status).toBe(201);

    const lines = await linesFor(agent, payment.body.payment.journalEntryId);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.accountCode === '4910')).toBeUndefined();
    expect(lines.find((l) => l.accountCode === '6810')).toBeUndefined();
  });

  it('a base-currency payment is unchanged', async () => {
    const agent = await loginAgent(app, userA);
    // No setUpFxFixture — org stays USD base, the pre-Phase-8 default.
    cashAccountId = await accountId(orgA, '1110');
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Local Co' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    const created = await agent.post(INVOICES).send({
      customerId,
      issueDate: '2026-01-01',
      dueDate: '2026-06-01',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitPriceCents: 100000, revenueAccountId, taxRateBp: 0 }],
    });
    const invoiceId = created.body.invoice.id as string;
    await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});

    const payment = await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-10',
      amountCents: 100000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 100000 }],
    });
    expect(payment.status).toBe(201);
    expect(payment.body.payment.fxRate).toBe('1.00000000');

    const lines = await linesFor(agent, payment.body.payment.journalEntryId);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.fxRate === '1.00000000')).toBe(true);
  });

  it('a partial settlement realizes FX only on the portion settled', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    cashAccountId = await accountId(orgA, '1110');
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    const invoiceId = await issueUsdInvoice(agent, customerId, revenueAccountId);

    const payment = await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-10',
      amountCents: 40000,
      currencyCode: 'USD',
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 40000 }],
    });
    expect(payment.status).toBe(201);

    const lines = await linesFor(agent, payment.body.payment.journalEntryId);
    const cash = lines.find((l) => l.accountCode === '1110');
    expect(cash?.baseDebitCents).toBe(3340000); // 40000 * 83.50
    const receivable = lines.find((l) => l.accountCode === '1120');
    expect(receivable?.baseCreditCents).toBe(3320000); // 40000 * 83.00
    const gain = lines.find((l) => l.accountCode === '4910');
    expect(gain?.creditCents).toBe(20000);
  });

  it('a payment settling two documents at different rates posts one control line each', async () => {
    const agent = await loginAgent(app, userA);
    const patched = await agent.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
    expect(patched.status).toBe(200);
    await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '82.00000000' });
    await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-02', rate: '83.00000000' });
    await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-10', rate: '83.50000000' });
    cashAccountId = await accountId(orgA, '1110');
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    // Invoice A frozen at 82.00 (base 8,200,000); invoice B frozen at 83.00 (base 8,300,000).
    const invoiceA = await issueUsdInvoice(agent, customerId, revenueAccountId, 100000, '2026-01-01');
    const invoiceB = await issueUsdInvoice(agent, customerId, revenueAccountId, 100000, '2026-01-02');

    const payment = await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-10',
      amountCents: 200000,
      currencyCode: 'USD',
      cashAccountId,
      customerId,
      allocations: [
        { invoiceId: invoiceA, billId: null, amountCents: 100000 },
        { invoiceId: invoiceB, billId: null, amountCents: 100000 },
      ],
    });
    expect(payment.status).toBe(201);

    const lines = await linesFor(agent, payment.body.payment.journalEntryId);
    expect(lines).toHaveLength(4); // cash + 2 control lines + plug

    const receivableLines = lines.filter((l) => l.accountCode === '1120');
    expect(receivableLines).toHaveLength(2);
    expect(receivableLines.map((l) => l.fxRate).sort()).toEqual(['82.00000000', '83.00000000']);

    // cash base debit: 200000 * 83.50 = 16,700,000
    // control base credits: 100000*82.00 + 100000*83.00 = 8,200,000 + 8,300,000 = 16,500,000
    // imbalance = 16,700,000 - 16,500,000 = 200,000 (gain)
    const gain = lines.find((l) => l.accountCode === '4910');
    expect(gain?.creditCents).toBe(200000);
  });

  it('voiding an FX payment reverses the realized gain', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    cashAccountId = await accountId(orgA, '1110');
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    const invoiceId = await issueUsdInvoice(agent, customerId, revenueAccountId);

    const payment = await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-10',
      amountCents: 100000,
      currencyCode: 'USD',
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 100000 }],
    });
    const paymentId = payment.body.payment.id as string;

    const voided = await agent.post(`${PAYMENTS}/${paymentId}/void`).send({});
    expect(voided.status).toBe(200);

    const reversalLines = await linesFor(agent, voided.body.payment.voidJournalEntryId);
    const gainReversal = reversalLines.find((l) => l.accountCode === '4910');
    expect(gainReversal?.debitCents).toBe(50000);

    const invoiceRes = await agent.get(`${INVOICES}/${invoiceId}`);
    expect(invoiceRes.body.invoice.amountDueCents).toBe(100000);
  });

  it('AR aging reconciles against the GL with a foreign-currency invoice outstanding', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerRes = await agent.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');

    await issueUsdInvoice(agent, customerId, revenueAccountId);

    const aging = await agent.get(`${REPORTS}/ar-aging`);
    expect(aging.body.reconciles).toBe(true);
    expect(aging.body.totalOutstandingCents).toBe(8300000);
  });
});

describe('cross-tenant isolation', () => {
  it("org B's realized FX accounts are never touched by org A's settlement", async () => {
    const agentA = await loginAgent(app, userA);
    await setUpFxFixture(agentA);
    cashAccountId = await accountId(orgA, '1110');
    const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    const invoiceId = await issueUsdInvoice(agentA, customerId, revenueAccountId);

    await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-10',
      amountCents: 100000,
      currencyCode: 'USD',
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 100000 }],
    });

    const gainAccountB = await accountId(userB.orgId, '4910');
    const { rows } = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(base_credit_cents - base_debit_cents), 0)::text AS balance
         FROM ledger_lines WHERE org_id = $1 AND account_id = $2`,
      [userB.orgId, gainAccountB],
    );
    expect(rows[0]?.balance).toBe('0');
  });

  it('org B cannot allocate a payment to org A\'s invoice', async () => {
    const agentA = await loginAgent(app, userA);
    await setUpFxFixture(agentA);
    const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Acme Global' });
    const customerId = customerRes.body.customer.id as string;
    const revenueAccountId = await accountId(orgA, '4100');
    const invoiceId = await issueUsdInvoice(agentA, customerId, revenueAccountId);

    const agentB = await loginAgent(app, userB);
    await agentB.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
    await agentB.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-10', rate: '83.50000000' });
    const cashAccountB = await accountId(userB.orgId, '1110');

    const res = await agentB.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-01-10',
      amountCents: 100000,
      currencyCode: 'USD',
      cashAccountId: cashAccountB,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 100000 }],
    });

    expect([404, 422]).toContain(res.status);
  });
});
