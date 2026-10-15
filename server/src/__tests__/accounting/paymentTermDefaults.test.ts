import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from 'supertest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 43a — payment-term rule types and org/party default terms.
 * Integration tier, real PostgreSQL. Includes the cross-tenant case (rule 15).
 */

const app = createApp();
const TERMS = '/api/v1/payment-terms';

let userA: SeededUser;
let userB: SeededUser;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
});

afterAll(closePool);

async function termId(agent: Agent, code: string): Promise<string> {
  const res = await agent.get(`${TERMS}?includeInactive=true`);
  const term = (res.body.paymentTerms as { id: string; code: string }[]).find((t) => t.code === code);
  if (term === undefined) throw new Error(`fixture: no term ${code}`);
  return term.id;
}

async function onboard(agent: Agent): Promise<void> {
  const res = await agent.post('/api/v1/settings/onboarding').send({
    organizationName: 'Acme Books',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 1,
    booksStartDate: '2026-01-01',
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`fixture: onboarding ${res.status} ${res.text}`);
}

async function accountOfType(agent: Agent, type: string): Promise<string> {
  const res = await agent.get('/api/v1/accounts');
  const a = (res.body.accounts as { id: string; type: string; isPostable: boolean }[]).find(
    (x) => x.type === type && x.isPostable,
  );
  if (a === undefined) throw new Error(`fixture: no ${type} account`);
  return a.id;
}

async function vendor(agent: Agent, body: Record<string, unknown> = {}): Promise<string> {
  const res = await agent.post('/api/v1/vendors').send({ name: 'Acme Supplies', ...body });
  if (res.status !== 201) throw new Error(`fixture: vendor ${res.status} ${res.text}`);
  return res.body.vendor.id as string;
}

async function customer(agent: Agent, body: Record<string, unknown> = {}): Promise<string> {
  const res = await agent.post('/api/v1/customers').send({ name: 'Northwind', ...body });
  if (res.status !== 201) throw new Error(`fixture: customer ${res.status} ${res.text}`);
  return res.body.customer.id as string;
}

async function postBill(agent: Agent, vendorId: string, extra: Record<string, unknown> = {}) {
  const expenseAccountId = await accountOfType(agent, 'Expense');
  return agent.post('/api/v1/bills').send({
    vendorId,
    vendorReference: 'REF-1',
    billDate: '2026-10-15',
    lines: [{ description: 'Supplies', quantityMilli: 1000, unitPriceCents: 10000, expenseAccountId }],
    ...extra,
  });
}

async function postInvoice(agent: Agent, customerId: string, extra: Record<string, unknown> = {}) {
  const revenueAccountId = await accountOfType(agent, 'Revenue');
  return agent.post('/api/v1/invoices').send({
    customerId,
    issueDate: '2026-10-15',
    lines: [{ description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId }],
    ...extra,
  });
}

async function nextTwentyTerm(agent: Agent): Promise<string> {
  const res = await agent
    .post(TERMS)
    .send({ code: 'NEXT20', name: '20th next month', netDays: 20, rule: 'DAY_OF_NEXT_MONTH' });
  if (res.status !== 201) throw new Error(`fixture: term ${res.status} ${res.text}`);
  return res.body.paymentTerm.id as string;
}

describe('payment term rules', () => {
  it('creates a DAY_OF_NEXT_MONTH term', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .post(TERMS)
      .send({ code: 'NEXT20', name: '20th next month', netDays: 20, rule: 'DAY_OF_NEXT_MONTH' });
    expect(res.status).toBe(201);
    expect(res.body.paymentTerm.rule).toBe('DAY_OF_NEXT_MONTH');
  });

  it('rejects a day-of-month rule with netDays 0', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent
      .post(TERMS)
      .send({ code: 'NEXT0', name: 'Bad', netDays: 0, rule: 'DAY_OF_NEXT_MONTH' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Day of month must be between 1 and 31');
  });

  it('refuses to change the rule of a system term', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.patch(`${TERMS}/${await termId(agent, 'NET_30')}`).send({ rule: 'DAY_OF_NEXT_MONTH' });
    expect(res.status).toBe(409);
  });
});

describe('default resolution', () => {
  it('a vendor default term derives the bill due date', async () => {
    const agent = await loginAgent(app, userA);
    const vendorId = await vendor(agent, { defaultPaymentTermId: await nextTwentyTerm(agent) });
    const res = await postBill(agent, vendorId, { paymentTermsCode: null });
    expect(res.status).toBe(201);
    expect(res.body.bill.dueDate).toBe('2026-11-20');
    expect(res.body.bill.paymentTermsCode).toBe('NEXT20');
  });

  it('falls back to the organization purchase default', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const patch = await agent.patch('/api/v1/settings').send({ defaultPurchasePaymentTermId: await termId(agent, 'NET_15') });
    expect(patch.status).toBe(200);
    const res = await postBill(agent, await vendor(agent), { paymentTermsCode: null });
    expect(res.status).toBe(201);
    expect(res.body.bill.dueDate).toBe('2026-10-30');
  });

  it('an explicit due date beats both defaults', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const vendorId = await vendor(agent, { defaultPaymentTermId: await nextTwentyTerm(agent) });
    const res = await postBill(agent, vendorId, { paymentTermsCode: null, dueDate: '2026-10-16' });
    expect(res.status).toBe(201);
    expect(res.body.bill.dueDate).toBe('2026-10-16');
  });

  it('a customer default term derives the invoice due date', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await customer(agent, { defaultPaymentTermId: await termId(agent, 'NET_7') });
    const res = await postInvoice(agent, customerId, { paymentTermsCode: null });
    expect(res.status).toBe(201);
    expect(res.body.invoice.dueDate).toBe('2026-10-22');
  });

  it('is a 422 when there is no default and no term or date', async () => {
    const agent = await loginAgent(app, userA);
    const res = await postBill(agent, await vendor(agent), { paymentTermsCode: null });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Provide a due date or a payment term');
  });

  it('skips a deactivated party default and uses the organization default', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const net7 = await termId(agent, 'NET_7');
    const customerId = await customer(agent, { defaultPaymentTermId: net7 });
    const off = await agent.patch(`${TERMS}/${net7}`).send({ isActive: false });
    expect(off.status).toBe(200);
    const res = await postInvoice(agent, customerId, { paymentTermsCode: null });
    expect(res.status).toBe(201);
    expect(res.body.invoice.dueDate).toBe('2026-11-14');
  });
});

describe('cross-tenant', () => {
  it('refuses another organization\'s term as a customer or settings default', async () => {
    const agentA = await loginAgent(app, userA);
    const agentB = await loginAgent(app, userB);
    await onboard(agentA);
    const foreign = await termId(agentB, 'NET_30');
    const customerId = await customer(agentA);

    const c = await agentA.patch(`/api/v1/customers/${customerId}`).send({ defaultPaymentTermId: foreign });
    expect(c.status).toBe(422);
    expect(c.body.error).toBe('Payment term not found or inactive');

    const s = await agentA.patch('/api/v1/settings').send({ defaultSalesPaymentTermId: foreign });
    expect(s.status).toBe(422);
    expect(s.body.error).toBe('Payment term not found or inactive');
  });
});

describe('onboarding', () => {
  it('sets both organization defaults to NET_30', async () => {
    const agent = await loginAgent(app, userA);
    await onboard(agent);
    const net30 = await termId(agent, 'NET_30');
    const res = await agent.get('/api/v1/settings');
    expect(res.body.settings.defaultSalesPaymentTermId).toBe(net30);
    expect(res.body.settings.defaultPurchasePaymentTermId).toBe(net30);
  });
});
