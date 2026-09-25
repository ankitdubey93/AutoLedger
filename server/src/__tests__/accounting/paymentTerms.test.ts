import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting — payment terms (Phase 24). Integration tier, real PostgreSQL.
 *
 * Includes the seven-standard-terms seeding, the derived-due-date behaviour
 * on invoices and bills, and this app's own cross-tenant isolation case
 * (rule 15). Fixture mirrors customers.test.ts's shape.
 */

const app = createApp();
const TERMS_BASE = '/api/v1/payment-terms';
const INVOICES_BASE = '/api/v1/invoices';
const BILLS_BASE = '/api/v1/bills';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;
});

afterAll(closePool);

async function createCustomer(agent: import('supertest').Agent): Promise<string> {
  const res = await agent.post('/api/v1/customers').send({ name: 'Northwind Traders' });
  return res.body.customer.id as string;
}

async function revenueAccountId(agent: import('supertest').Agent): Promise<string> {
  const res = await agent.get('/api/v1/accounts');
  const account = (res.body.accounts as { id: string; type: string; isPostable: boolean }[]).find(
    (a) => a.type === 'Revenue' && a.isPostable,
  );
  if (account === undefined) throw new Error('fixture: no postable Revenue account seeded');
  return account.id;
}

async function vendorAndExpenseAccount(
  agent: import('supertest').Agent,
): Promise<{ vendorId: string; expenseAccountId: string }> {
  const vendorRes = await agent.post('/api/v1/vendors').send({ name: 'Acme Supplies' });
  const accountsRes = await agent.get('/api/v1/accounts');
  const account = (accountsRes.body.accounts as { id: string; type: string; isPostable: boolean }[]).find(
    (a) => a.type === 'Expense' && a.isPostable,
  );
  if (account === undefined) throw new Error('fixture: no postable Expense account seeded');
  return { vendorId: vendorRes.body.vendor.id as string, expenseAccountId: account.id };
}

describe('GET /payment-terms', () => {
  it('a newly registered organization starts with the seven standard terms', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.get(TERMS_BASE);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(7);
    expect(res.body.paymentTerms.map((t: { code: string }) => t.code)).toEqual([
      'DUE_ON_RECEIPT',
      'NET_7',
      'NET_15',
      'NET_30',
      'NET_45',
      'NET_60',
      'NET_90',
    ]);
    for (const term of res.body.paymentTerms) {
      expect(term.isSystem).toBe(true);
    }
  });
});

describe('POST /payment-terms', () => {
  it('creates a custom term and uppercases its code', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(TERMS_BASE).send({ code: 'net_21', name: 'Net 21', netDays: 21 });

    expect(res.status).toBe(201);
    expect(res.body.paymentTerm.code).toBe('NET_21');
    expect(res.body.paymentTerm.isSystem).toBe(false);
  });

  it('rejects a duplicate code', async () => {
    const agent = await loginAgent(app, userA);
    const res = await agent.post(TERMS_BASE).send({ code: 'NET_30', name: 'Net 30 again', netDays: 30 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Payment term code already exists');
  });
});

describe('PATCH /payment-terms/:id', () => {
  async function idFor(agent: import('supertest').Agent, code: string): Promise<string> {
    const res = await agent.get(TERMS_BASE);
    const term = (res.body.paymentTerms as { id: string; code: string }[]).find((t) => t.code === code);
    if (term === undefined) throw new Error(`fixture: no term ${code}`);
    return term.id;
  }

  it('refuses to rename a standard term', async () => {
    const agent = await loginAgent(app, userA);
    const id = await idFor(agent, 'NET_30');

    const res = await agent.patch(`${TERMS_BASE}/${id}`).send({ name: 'Thirty days' });

    expect(res.status).toBe(409);
  });

  it('deactivates a standard term', async () => {
    const agent = await loginAgent(app, userA);
    const id = await idFor(agent, 'NET_90');

    const res = await agent.patch(`${TERMS_BASE}/${id}`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.paymentTerm.isActive).toBe(false);

    const defaultList = await agent.get(TERMS_BASE);
    expect(defaultList.body.count).toBe(6);

    const withInactive = await agent.get(`${TERMS_BASE}?includeInactive=true`);
    expect(withInactive.body.count).toBe(7);
  });
});

describe('derived due dates on invoices and bills', () => {
  it('POST /invoices with paymentTermsCode and no dueDate derives the due date', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const accountId = await revenueAccountId(agent);

    const res = await agent.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      paymentTermsCode: 'NET_30',
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId: accountId }],
    });

    expect(res.status).toBe(201);
    expect(res.body.invoice.dueDate).toBe('2026-03-31');
    expect(res.body.invoice.paymentTerms).toBe('Net 30');
    expect(res.body.invoice.paymentTermsCode).toBe('NET_30');
  });

  it('DUE_ON_RECEIPT derives a due date equal to the issue date', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const accountId = await revenueAccountId(agent);

    const res = await agent.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      paymentTermsCode: 'DUE_ON_RECEIPT',
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId: accountId }],
    });

    expect(res.status).toBe(201);
    expect(res.body.invoice.dueDate).toBe('2026-03-01');
  });

  it('an explicit dueDate overrides the term', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const accountId = await revenueAccountId(agent);

    const res = await agent.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      dueDate: '2026-03-10',
      paymentTermsCode: 'NET_30',
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId: accountId }],
    });

    expect(res.status).toBe(201);
    expect(res.body.invoice.dueDate).toBe('2026-03-10');
  });

  it('POST /invoices with neither dueDate nor paymentTermsCode is rejected', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const accountId = await revenueAccountId(agent);

    const res = await agent.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId: accountId }],
    });

    expect(res.status).toBe(400);
  });

  it('an unknown paymentTermsCode is rejected', async () => {
    const agent = await loginAgent(app, userA);
    const customerId = await createCustomer(agent);
    const accountId = await revenueAccountId(agent);

    const res = await agent.post(INVOICES_BASE).send({
      customerId,
      issueDate: '2026-03-01',
      paymentTermsCode: 'NET_999',
      lines: [{ description: 'Consulting', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId: accountId }],
    });

    expect(res.status).toBe(422);
  });

  it('POST /bills derives the due date from billDate', async () => {
    const agent = await loginAgent(app, userA);
    const { vendorId, expenseAccountId } = await vendorAndExpenseAccount(agent);

    const res = await agent.post(BILLS_BASE).send({
      vendorId,
      vendorReference: 'INV-001',
      billDate: '2026-01-31',
      paymentTermsCode: 'NET_30',
      lines: [{ description: 'Supplies', quantityMilli: 1000, unitPriceCents: 10000, expenseAccountId }],
    });

    expect(res.status).toBe(201);
    expect(res.body.bill.dueDate).toBe('2026-03-02');
  });
});

describe('cross-tenant isolation on payment terms', () => {
  it('org A cannot see or patch org B payment terms', async () => {
    const agentC = await loginAgent(app, userC);
    const created = await agentC.post(TERMS_BASE).send({ code: 'NET_21', name: 'Net 21', netDays: 21 });
    const termId = created.body.paymentTerm.id as string;

    const agentA = await loginAgent(app, userA);
    const listRes = await agentA.get(TERMS_BASE);
    expect((listRes.body.paymentTerms as { code: string }[]).some((t) => t.code === 'NET_21')).toBe(false);

    const patchRes = await agentA.patch(`${TERMS_BASE}/${termId}`).send({ isActive: false });
    expect(patchRes.status).toBe(404);

    const readBack = await agentC.get(TERMS_BASE);
    const stillThere = (readBack.body.paymentTerms as { code: string; isActive: boolean }[]).find(
      (t) => t.code === 'NET_21',
    );
    expect(stillThere?.isActive).toBe(true);
    expect(orgB).not.toBe(orgA);
  });
});
