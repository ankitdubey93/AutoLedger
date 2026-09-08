import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 7 — outbox emission from real financial services. Integration
 * tier, real PostgreSQL. Proves each of the five events fires exactly once
 * on the documented action, that a rolled-back posting emits nothing, and
 * that events stay org-scoped.
 */

const app = createApp();
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const PAYMENTS = '/api/v1/ledger-core/payments';
const PERIODS = '/api/v1/ledger-core/fiscal-periods';
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';
const SETTINGS = '/api/v1/ledger-core/settings';
const ONBOARDING = '/api/v1/ledger-core/settings/onboarding';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function eventCount(orgId?: string): Promise<number> {
  const { rows } =
    orgId === undefined
      ? await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox_events')
      : await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox_events WHERE org_id = $1', [orgId]);
  return Number(rows[0]!.n);
}

async function eventsOfType(eventType: string): Promise<{ payload: Record<string, unknown>; org_id: string }[]> {
  const { rows } = await pool.query<{ payload: Record<string, unknown>; org_id: string }>(
    'SELECT payload, org_id FROM outbox_events WHERE event_type = $1',
    [eventType],
  );
  return rows;
}

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

async function createCustomer(agent: Agent, name = 'Northwind Traders'): Promise<string> {
  const res = await agent.post(CUSTOMERS).send({ name });
  return res.body.customer.id as string;
}

async function createVendor(agent: Agent, name = 'Acme Supplies'): Promise<string> {
  const res = await agent.post(VENDORS).send({ name });
  return res.body.vendor.id as string;
}

async function createAndIssueInvoice(
  agent: Agent,
  customerId: string,
  revenueAccountId: string,
  amountCents = 100000,
  issueDate = '2026-06-01',
): Promise<{ id: string; totalCents: number; status: number }> {
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'Consulting', quantityMilli: 1000, unitPriceCents: amountCents, revenueAccountId, taxRateBp: 0 },
    ],
  });
  const invoiceId = created.body.invoice.id as string;
  const issued = await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
  return { id: invoiceId, totalCents: amountCents, status: issued.status };
}

async function createSubmitApproveBill(
  agent: Agent,
  vendorId: string,
  expenseAccountId: string,
  amountCents = 60000,
): Promise<{ id: string; totalCents: number }> {
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: 'VEND-EMIT-1',
    billDate: '2026-06-01',
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'Supplies', quantityMilli: 1000, unitPriceCents: amountCents, expenseAccountId, taxRateBp: 0 },
    ],
  });
  const billId = created.body.bill.id as string;
  await agent.post(`${BILLS}/${billId}/submit`).send({});
  await agent.post(`${BILLS}/${billId}/approve`).send({});
  return { id: billId, totalCents: amountCents };
}

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  agentA = await loginAgent(app, userA);
});

afterAll(closePool);

describe('invoice.issued', () => {
  it('issuing an invoice writes exactly one invoice.issued event', async () => {
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');
    const invoice = await createAndIssueInvoice(agentA, customerId, revenueAccountId, 100000);
    expect(invoice.status).toBe(200);

    const events = await eventsOfType('invoice.issued');
    expect(events.length).toBe(1);
    expect(events[0]!.org_id).toBe(orgA);
    expect(events[0]!.payload.totalCents).toBe(100000);
    expect(typeof events[0]!.payload.totalCents).toBe('number');
  });

  it('a failed invoice issue writes no event', async () => {
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');

    await onboard(agentA);
    const genRes = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
    const june = (genRes.body.periods as { id: string; periodNumber: number }[]).find((p) => p.periodNumber === 6);
    if (june === undefined) throw new Error('fixture: no June period generated');
    await agentA.post(`${PERIODS}/${june.id}/close`).send({});
    await agentA.post(`${PERIODS}/${june.id}/lock`).send({});

    // Closing/locking the period itself emits fiscal_period.closed — the
    // baseline is taken after that setup, so this test isolates the
    // invoice's own (failed) attempt.
    const before = await eventCount(orgA);

    const created = await agentA.post(INVOICES).send({
      customerId,
      issueDate: '2026-06-15',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'X', quantityMilli: 1000, unitPriceCents: 5000, revenueAccountId, taxRateBp: 0 }],
    });
    const issueRes = await agentA.post(`${INVOICES}/${created.body.invoice.id}/issue`).send({});
    expect(issueRes.status).toBe(422);

    expect(await eventCount(orgA)).toBe(before);
  });
});

describe('bill.approved', () => {
  it('approving a bill writes exactly one bill.approved event', async () => {
    const vendorId = await createVendor(agentA);
    const expenseAccountId = await accountId(orgA, '6130');
    await createSubmitApproveBill(agentA, vendorId, expenseAccountId, 60000);

    const events = await eventsOfType('bill.approved');
    expect(events.length).toBe(1);
    expect(events[0]!.payload.totalCents).toBe(60000);
  });
});

describe('payment.recorded', () => {
  it('recording a payment writes exactly one payment.recorded event', async () => {
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');
    const cashAccountId = await accountId(orgA, '1110');
    const invoice = await createAndIssueInvoice(agentA, customerId, revenueAccountId, 40000);

    const before = await eventCount(orgA);
    const payRes = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });
    expect(payRes.status).toBe(201);

    const events = await eventsOfType('payment.recorded');
    expect(events.length).toBe(1);
    expect(await eventCount(orgA)).toBe(before + 1);
  });

  it('voiding a payment writes no event', async () => {
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');
    const cashAccountId = await accountId(orgA, '1110');
    const invoice = await createAndIssueInvoice(agentA, customerId, revenueAccountId, 40000);

    const payRes = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });
    const paymentId = payRes.body.payment.id as string;

    const before = await eventCount(orgA);
    const voidRes = await agentA.post(`${PAYMENTS}/${paymentId}/void`).send({});
    expect(voidRes.status).toBe(200);
    expect(await eventCount(orgA)).toBe(before);
  });

  it('matching a bank line to an invoice also writes payment.recorded', async () => {
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');
    const cashAccountId = await accountId(orgA, '1110');
    const invoice = await createAndIssueInvoice(agentA, customerId, revenueAccountId, 40000);

    const importRes = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'single.csv',
      content: `Date,Description,Amount\n2026-06-01,PMT ${invoice.id.slice(0, 8)},400.00`,
      dateFormat: 'ISO',
    });
    expect(importRes.status).toBe(201);

    const listRes = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=UNMATCHED&limit=10`);
    const txnId = (listRes.body.transactions as { id: string }[])[0]?.id;
    if (txnId === undefined) throw new Error('fixture: no imported transaction');

    const before = await eventCount(orgA);
    const matchRes = await agentA.post(`${BANK_TRANSACTIONS}/${txnId}/match`).send({ invoiceId: invoice.id });
    expect(matchRes.status).toBe(200);

    expect(await eventCount(orgA)).toBe(before + 1);
    const events = await eventsOfType('payment.recorded');
    expect(events.length).toBe(1);
  });
});

describe('fiscal_period.closed', () => {
  it('closing a fiscal period writes fiscal_period.closed; locking it writes nothing more', async () => {
    await onboard(agentA);
    const genRes = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
    const june = (genRes.body.periods as { id: string; periodNumber: number }[]).find((p) => p.periodNumber === 6);
    if (june === undefined) throw new Error('fixture: no June period generated');

    const before = await eventCount(orgA);
    const closeRes = await agentA.post(`${PERIODS}/${june.id}/close`).send({});
    expect(closeRes.status).toBe(200);
    expect(await eventCount(orgA)).toBe(before + 1);

    const lockRes = await agentA.post(`${PERIODS}/${june.id}/lock`).send({});
    expect(lockRes.status).toBe(200);
    expect(await eventCount(orgA)).toBe(before + 1);

    const events = await eventsOfType('fiscal_period.closed');
    expect(events.length).toBe(1);
  });
});

describe('bank.large_unmatched', () => {
  it('with the threshold at 0 (default), no event fires', async () => {
    const cashAccountId = await accountId(orgA, '1110');

    const importRes = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'big.csv',
      content: `Date,Description,Amount\n2026-06-01,Big deposit,5000.00`,
      dateFormat: 'ISO',
    });
    expect(importRes.status).toBe(201);

    expect(await eventCount(orgA)).toBe(0);
  });

  it('only lines at or above the configured threshold emit, and a negative amount also counts', async () => {
    const cashAccountId = await accountId(orgA, '1110');
    await onboard(agentA);
    const settingsRes = await agentA.patch(SETTINGS).send({ unmatchedAlertThresholdCents: 100000 });
    expect(settingsRes.status).toBe(200);

    const importRes = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'mixed.csv',
      content:
        'Date,Description,Amount\n' +
        '2026-06-01,Big inflow,2500.00\n' +
        '2026-06-02,Big outflow,-5000.00\n' +
        '2026-06-03,Small,99.00',
      dateFormat: 'ISO',
    });
    expect(importRes.status).toBe(201);
    expect(importRes.body.importedCount).toBe(3);

    const events = await eventsOfType('bank.large_unmatched');
    expect(events.length).toBe(2);
    const amounts = events.map((e) => e.payload.amountCents).sort((a, b) => (a as number) - (b as number));
    expect(amounts).toEqual([-500000, 250000]);
  });

  it('re-importing the same statement emits no further events', async () => {
    const cashAccountId = await accountId(orgA, '1110');
    await onboard(agentA);
    await agentA.patch(SETTINGS).send({ unmatchedAlertThresholdCents: 100000 });

    const content = 'Date,Description,Amount\n2026-06-01,Big inflow,2500.00';
    await agentA.post(BANK_IMPORTS).send({ accountId: cashAccountId, fileName: 'dup.csv', content, dateFormat: 'ISO' });
    const before = await eventCount(orgA);

    const secondRes = await agentA.post(BANK_IMPORTS).send({ accountId: cashAccountId, fileName: 'dup.csv', content, dateFormat: 'ISO' });
    expect(secondRes.status).toBe(201);
    expect(secondRes.body.importedCount).toBe(0);

    expect(await eventCount(orgA)).toBe(before);
  });
});

describe('cross-tenant scoping', () => {
  it('every emitted event carries the acting org, and org B sees none of org A\'s activity', async () => {
    const customerId = await createCustomer(agentA);
    const revenueAccountId = await accountId(orgA, '4100');
    await createAndIssueInvoice(agentA, customerId, revenueAccountId, 100000);

    const vendorId = await createVendor(agentA);
    const expenseAccountId = await accountId(orgA, '6130');
    await createSubmitApproveBill(agentA, vendorId, expenseAccountId, 60000);

    expect(await eventCount(orgB)).toBe(0);

    const { rows } = await pool.query<{ org_id: string }>('SELECT DISTINCT org_id FROM outbox_events');
    expect(rows.map((r) => r.org_id)).toEqual([orgA]);
  });
});
