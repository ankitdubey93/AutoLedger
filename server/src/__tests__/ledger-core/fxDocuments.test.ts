import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — foreign-currency invoices and bills (Phase 8). Integration
 * tier, real PostgreSQL. Includes this module's own cross-tenant isolation
 * case (rule 15).
 *
 * Fixture: org A's base currency is set to INR (via PATCH /organizations),
 * with a USD -> INR rate of 83.00 on 2026-01-01 and 84.00 on 2026-02-01.
 */

const app = createApp();
const ORGANIZATIONS = '/api/v1/organizations';
const RATES = '/api/v1/ledger-core/fx-rates';
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const JOURNALS = '/api/v1/ledger-core/journals';
const REPORTS = '/api/v1/ledger-core/reports';

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

async function createCustomer(agent: Agent, name = 'Acme Global'): Promise<string> {
  const res = await agent.post(CUSTOMERS).send({ name });
  return res.body.customer.id as string;
}

async function createVendor(agent: Agent, name = 'Global Supplies'): Promise<string> {
  const res = await agent.post(VENDORS).send({ name });
  return res.body.vendor.id as string;
}

async function setUpFxFixture(agent: Agent): Promise<void> {
  const patched = await agent.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
  if (patched.status !== 200) throw new Error(`fixture: baseCurrency patch failed ${patched.status}`);

  await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });
  await agent.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-02-01', rate: '84.00000000' });
}

/** $1,000.00 (100000 cents), no tax, on a single revenue/expense account. */
function invoicePayload(overrides: {
  customerId: string;
  revenueAccountId: string;
  currencyCode?: string;
  issueDate?: string;
  dueDate?: string;
}) {
  return {
    customerId: overrides.customerId,
    issueDate: overrides.issueDate ?? '2026-01-10',
    dueDate: overrides.dueDate ?? '2026-02-10',
    currencyCode: overrides.currencyCode,
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Consulting',
        quantityMilli: 1000,
        unitPriceCents: 100000,
        revenueAccountId: overrides.revenueAccountId,
        taxRateBp: 0,
      },
    ],
  };
}

function billPayload(overrides: {
  vendorId: string;
  expenseAccountId: string;
  currencyCode?: string;
  vendorReference?: string;
  billDate?: string;
  dueDate?: string;
}) {
  return {
    vendorId: overrides.vendorId,
    vendorReference: overrides.vendorReference ?? 'FX-001',
    billDate: overrides.billDate ?? '2026-01-10',
    dueDate: overrides.dueDate ?? '2026-02-10',
    currencyCode: overrides.currencyCode,
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Cloud hosting',
        quantityMilli: 1000,
        unitPriceCents: 100000,
        expenseAccountId: overrides.expenseAccountId,
        taxRateBp: 0,
      },
    ],
  };
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  orgA = userA.orgId;
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(closePool);

describe('foreign-currency invoices', () => {
  it('a draft invoice in a foreign currency stores the rate and base totals', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId, currencyCode: 'USD' }));

    expect(res.status).toBe(201);
    expect(res.body.invoice.fxRate).toBe('83.00000000');
    expect(res.body.invoice.subtotalCents).toBe(100000);
    expect(res.body.invoice.baseSubtotalCents).toBe(8300000);
    expect(res.body.invoice.baseTotalCents).toBe(8300000);
  });

  it('issuing a foreign-currency invoice posts native USD lines with base INR amounts', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId, currencyCode: 'USD' }));
    const invoiceId = created.body.invoice.id as string;

    const issued = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
    expect(issued.status).toBe(200);

    const journalRes = await agent.get(`${JOURNALS}/${issued.body.invoice.journalEntryId}`);
    const lines = journalRes.body.entry.lines as {
      accountCode: string;
      debitCents: number;
      creditCents: number;
      currencyCode: string;
      fxRate: string;
      baseDebitCents: number;
      baseCreditCents: number;
    }[];

    const receivable = lines.find((l) => l.accountCode === '1120');
    expect(receivable).toMatchObject({
      currencyCode: 'USD',
      debitCents: 100000,
      fxRate: '83.00000000',
      baseDebitCents: 8300000,
    });

    const revenue = lines.find((l) => l.accountCode === '4100');
    expect(revenue).toMatchObject({
      currencyCode: 'USD',
      creditCents: 100000,
      fxRate: '83.00000000',
      baseCreditCents: 8300000,
    });
  });

  it('a currency with no rate on or before the issue date is refused', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agent.post(INVOICES).send(
      invoicePayload({
        customerId,
        revenueAccountId,
        currencyCode: 'USD',
        issueDate: '2025-12-31',
        dueDate: '2026-01-31',
      }),
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('No exchange rate for USD to');
  });

  it('the rate is the latest on or before, not the exact date', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const res = await agent.post(INVOICES).send(
      invoicePayload({
        customerId,
        revenueAccountId,
        currencyCode: 'USD',
        issueDate: '2026-01-15',
        dueDate: '2026-02-15',
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.invoice.fxRate).toBe('83.00000000');
  });

  it('a base-currency invoice is unchanged', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');

    const created = await agent.post(INVOICES).send(invoicePayload({ customerId, revenueAccountId }));
    expect(created.body.invoice.fxRate).toBe('1.00000000');
    expect(created.body.invoice.baseTotalCents).toBe(created.body.invoice.totalCents);

    const invoiceId = created.body.invoice.id as string;
    const issued = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
    const journalRes = await agent.get(`${JOURNALS}/${issued.body.invoice.journalEntryId}`);
    const lines = journalRes.body.entry.lines as { currencyCode: string }[];
    expect(lines.every((l) => l.currencyCode === 'INR')).toBe(true);
  });

  it('the trial balance reports a foreign-currency invoice in base currency', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const customerId = await createCustomer(agent);
    const revenueAccountId = await accountId(orgA, '4100');
    const created = await agent
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId, currencyCode: 'USD' }));
    const invoiceId = created.body.invoice.id as string;
    await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});

    const trialBalance = await agent.get(`${REPORTS}/trial-balance`);
    const receivableRow = trialBalance.body.rows.find((r: { code: string }) => r.code === '1120');

    expect(receivableRow.debitCents).toBe(8300000);
  });
});

describe('foreign-currency bills', () => {
  it('a foreign-currency bill mirrors the invoice', async () => {
    const agent = await loginAgent(app, userA);
    await setUpFxFixture(agent);
    const vendorId = await createVendor(agent);
    const expenseAccountId = await accountId(orgA, '6120');

    const created = await agent
      .post(BILLS)
      .send(billPayload({ vendorId, expenseAccountId, currencyCode: 'USD' }));
    expect(created.status).toBe(201);
    expect(created.body.bill.fxRate).toBe('83.00000000');
    expect(created.body.bill.baseTotalCents).toBe(8300000);

    const billId = created.body.bill.id as string;
    await agent.post(`${BILLS}/${billId}/submit`).send({});
    const approved = await agent.post(`${BILLS}/${billId}/approve`).send({});
    expect(approved.status).toBe(200);

    const journalRes = await agent.get(`${JOURNALS}/${approved.body.bill.journalEntryId}`);
    const lines = journalRes.body.entry.lines as {
      accountCode: string;
      debitCents: number;
      creditCents: number;
      currencyCode: string;
      fxRate: string;
      baseDebitCents: number;
      baseCreditCents: number;
    }[];

    const expense = lines.find((l) => l.accountCode === '6120');
    expect(expense).toMatchObject({
      currencyCode: 'USD',
      debitCents: 100000,
      fxRate: '83.00000000',
      baseDebitCents: 8300000,
    });

    const payable = lines.find((l) => l.accountCode === '2100');
    expect(payable).toMatchObject({
      currencyCode: 'USD',
      creditCents: 100000,
      fxRate: '83.00000000',
      baseCreditCents: 8300000,
    });
  });
});

describe('cross-tenant isolation', () => {
  it('an organization with no USD rate of its own cannot create a USD invoice, even though org A has one', async () => {
    const agentA = await loginAgent(app, userA);
    await setUpFxFixture(agentA);

    const agentB = await loginAgent(app, userB);
    await agentB.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
    const customerId = await createCustomer(agentB);
    const revenueAccountId = await accountId(userB.orgId, '4100');

    const res = await agentB
      .post(INVOICES)
      .send(invoicePayload({ customerId, revenueAccountId, currencyCode: 'USD' }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('No exchange rate for USD to');
  });
});
