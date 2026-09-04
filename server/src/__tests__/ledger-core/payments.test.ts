import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — payments (Phase 3.9). Integration tier, real PostgreSQL.
 *
 * Includes this module's own cross-tenant isolation suite (rule 15). Every
 * test starts from a seeded ISSUED invoice of 100000 cents and a POSTED bill
 * of 60000 cents, both with no tax, so allocation arithmetic is round.
 */

const app = createApp();
const PAYMENTS = '/api/v1/ledger-core/payments';
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const JOURNALS = '/api/v1/ledger-core/journals';

let userA: SeededUser;
let userC: SeededUser;
let orgA: string;
let orgB: string;

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

async function seedIssuedInvoice(
  agent: Agent,
  orgId: string,
  customerId: string,
): Promise<{ id: string; totalCents: number }> {
  const revenueAccountId = await accountId(orgId, '4100');
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate: '2026-06-01',
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Consulting',
        quantityMilli: 1000,
        unitPriceCents: 100000,
        revenueAccountId,
        taxRateBp: 0,
      },
    ],
  });
  const invoiceId = created.body.invoice.id as string;
  await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
  return { id: invoiceId, totalCents: 100000 };
}

async function seedPostedBill(
  agent: Agent,
  orgId: string,
  vendorId: string,
): Promise<{ id: string; totalCents: number }> {
  const expenseAccountId = await accountId(orgId, '6130');
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: 'VEND-PAY-1',
    billDate: '2026-06-01',
    dueDate: '2026-12-31',
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Supplies',
        quantityMilli: 1000,
        unitPriceCents: 60000,
        expenseAccountId,
        taxRateBp: 0,
      },
    ],
  });
  const billId = created.body.bill.id as string;
  await agent.post(`${BILLS}/${billId}/submit`).send({});
  await agent.post(`${BILLS}/${billId}/approve`).send({});
  return { id: billId, totalCents: 60000 };
}

let agentA: Agent;
let cashAccountId: string;
let customerId: string;
let vendorId: string;
let invoice: { id: string; totalCents: number };
let bill: { id: string; totalCents: number };

beforeEach(async () => {
  await resetTables();

  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userC = await createUserWithOrg({ label: 'carol', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userC.orgId;

  agentA = await loginAgent(app, userA);
  cashAccountId = await accountId(orgA, '1110');

  const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Northwind Traders' });
  customerId = customerRes.body.customer.id as string;
  const vendorRes = await agentA.post(VENDORS).send({ name: 'Acme Supplies' });
  vendorId = vendorRes.body.vendor.id as string;

  invoice = await seedIssuedInvoice(agentA, orgA, customerId);
  bill = await seedPostedBill(agentA, orgA, vendorId);
});

afterAll(closePool);

describe('POST /ledger-core/payments — RECEIVE', () => {
  it('partially settles an invoice', async () => {
    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });

    expect(res.status).toBe(201);

    const invoiceRes = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(invoiceRes.body.invoice.allocatedCents).toBe(40000);
    expect(invoiceRes.body.invoice.amountDueCents).toBe(60000);
    expect(invoiceRes.body.invoice.settlementStatus).toBe('PARTIALLY_PAID');
  });

  it('fully settles an invoice across two payments', async () => {
    await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });
    await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-02',
      amountCents: 60000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 60000 }],
    });

    const invoiceRes = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(invoiceRes.body.invoice.amountDueCents).toBe(0);
    expect(invoiceRes.body.invoice.settlementStatus).toBe('PAID');
  });

  it('rejects an allocation that overshoots the amount still due', async () => {
    await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 100000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 100000 }],
    });

    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-02',
      amountCents: 1,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 1 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('exceeds the amount still due');
  });

  it('rejects allocations that do not sum to the payment amount', async () => {
    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 30000 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Allocations must sum to the payment amount');
  });

  it('posts debit cash / credit receivable', async () => {
    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });

    const journalRes = await agentA.get(`${JOURNALS}/${res.body.payment.journalEntryId}`);
    expect(journalRes.body.entry.sourceType).toBe('payment');
    expect(journalRes.body.entry.sourceId).toBe(res.body.payment.id);

    const lines = journalRes.body.entry.lines as {
      accountCode: string;
      debitCents: number;
      creditCents: number;
    }[];
    const cash = lines.find((l) => l.accountCode === '1110');
    const receivable = lines.find((l) => l.accountCode === '1120');
    expect(cash?.debitCents).toBe(40000);
    expect(receivable?.creditCents).toBe(40000);
  });

  it('rejects allocating a RECEIVE to a bill', async () => {
    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: null, billId: bill.id, amountCents: 40000 }],
    });

    expect(res.status).toBe(422);
  });

  it('rejects allocating to another customer’s invoice', async () => {
    const otherCustomerRes = await agentA.post(CUSTOMERS).send({ name: 'Other Customer' });
    const otherCustomerId = otherCustomerRes.body.customer.id as string;

    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId: otherCustomerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('That document belongs to a different counterparty');
  });

  it('rejects allocating to a DRAFT invoice', async () => {
    const revenueAccountId = await accountId(orgA, '4100');
    const draft = await agentA.post(INVOICES).send({
      customerId,
      issueDate: '2026-06-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [
        { description: 'x', quantityMilli: 1000, unitPriceCents: 5000, revenueAccountId, taxRateBp: 0 },
      ],
    });
    const draftId = draft.body.invoice.id as string;

    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 5000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: draftId, billId: null, amountCents: 5000 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only an issued invoice can be paid');
  });

  it('rejects a non-Asset cash account', async () => {
    const expenseAccountId = await accountId(orgA, '6130');
    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId: expenseAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });

    expect(res.status).toBe(422);
  });

  it('rejects an allocation naming both invoiceId and billId', async () => {
    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: bill.id, amountCents: 40000 }],
    });

    expect(res.status).toBe(400);
  });

  it('is rejected for a VIEWER', async () => {
    const viewer = await createUserWithOrg({ label: 'eve', orgName: 'Org Eve' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });

    expect(res.status).toBe(403);
  });
});

describe('POST /ledger-core/payments — PAY', () => {
  it('posts debit payable / credit cash', async () => {
    const res = await agentA.post(PAYMENTS).send({
      direction: 'PAY',
      paymentDate: '2026-07-01',
      amountCents: 60000,
      cashAccountId,
      vendorId,
      allocations: [{ invoiceId: null, billId: bill.id, amountCents: 60000 }],
    });

    expect(res.status).toBe(201);

    const journalRes = await agentA.get(`${JOURNALS}/${res.body.payment.journalEntryId}`);
    const lines = journalRes.body.entry.lines as {
      accountCode: string;
      debitCents: number;
      creditCents: number;
    }[];
    const payable = lines.find((l) => l.accountCode === '2100');
    const cash = lines.find((l) => l.accountCode === '1110');
    expect(payable?.debitCents).toBe(60000);
    expect(cash?.creditCents).toBe(60000);
  });

  it('rejects allocating to an AWAITING_APPROVAL bill', async () => {
    const expenseAccountId = await accountId(orgA, '6130');
    const created = await agentA.post(BILLS).send({
      vendorId,
      vendorReference: 'VEND-PAY-2',
      billDate: '2026-06-01',
      dueDate: '2026-12-31',
      notes: null,
      paymentTerms: null,
      lines: [
        { description: 'x', quantityMilli: 1000, unitPriceCents: 5000, expenseAccountId, taxRateBp: 0 },
      ],
    });
    const billId = created.body.bill.id as string;
    await agentA.post(`${BILLS}/${billId}/submit`).send({});

    const res = await agentA.post(PAYMENTS).send({
      direction: 'PAY',
      paymentDate: '2026-07-01',
      amountCents: 5000,
      cashAccountId,
      vendorId,
      allocations: [{ invoiceId: null, billId, amountCents: 5000 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only an approved bill can be paid');
  });
});

describe('POST /ledger-core/payments/:id/void', () => {
  it('un-settles the invoice it paid', async () => {
    const created = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });
    const paymentId = created.body.payment.id as string;

    const before = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(before.body.invoice.allocatedCents).toBe(40000);

    const res = await agentA.post(`${PAYMENTS}/${paymentId}/void`).send({});
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('VOID');

    const after = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(after.body.invoice.allocatedCents).toBe(0);
    expect(after.body.invoice.settlementStatus).not.toBe('PARTIALLY_PAID');
  });

  it('rejects voiding twice', async () => {
    const created = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });
    const paymentId = created.body.payment.id as string;
    await agentA.post(`${PAYMENTS}/${paymentId}/void`).send({});

    const res = await agentA.post(`${PAYMENTS}/${paymentId}/void`).send({});
    expect(res.status).toBe(409);
  });

  it('rejects voiding an invoice with a POSTED payment applied, and allows it after the payment is voided', async () => {
    const created = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });
    const paymentId = created.body.payment.id as string;

    const blockedVoid = await agentA.post(`${INVOICES}/${invoice.id}/void`).send({});
    expect(blockedVoid.status).toBe(409);
    expect(blockedVoid.body.error).toContain('Void the payments first');

    await agentA.post(`${PAYMENTS}/${paymentId}/void`).send({});

    const allowedVoid = await agentA.post(`${INVOICES}/${invoice.id}/void`).send({});
    expect(allowedVoid.status).toBe(200);
  });
});

describe('trial balance stays balanced through payment activity', () => {
  it('after a partial RECEIVE and a full PAY', async () => {
    await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });
    await agentA.post(PAYMENTS).send({
      direction: 'PAY',
      paymentDate: '2026-07-01',
      amountCents: 60000,
      cashAccountId,
      vendorId,
      allocations: [{ invoiceId: null, billId: bill.id, amountCents: 60000 }],
    });

    const trialBalanceRes = await agentA.get('/api/v1/ledger-core/reports/trial-balance');
    expect(trialBalanceRes.body.isBalanced).toBe(true);
  });
});

describe('cross-tenant isolation', () => {
  it('GET /:id with another org payment id returns 404', async () => {
    const created = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });
    const paymentId = created.body.payment.id as string;

    const agentC = await loginAgent(app, userC);
    const res = await agentC.get(`${PAYMENTS}/${paymentId}`);
    expect(res.status).toBe(404);
  });

  it('rejects allocating to another org’s invoice with 422, leaving it unpaid', async () => {
    const agentC = await loginAgent(app, userC);
    const customerCRes = await agentC.post(CUSTOMERS).send({ name: 'Bravo Customer' });
    const customerCId = customerCRes.body.customer.id as string;
    const cashAccountCId = await accountId(orgB, '1110');

    const res = await agentC.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId: cashAccountCId,
      customerId: customerCId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });

    expect(res.status).toBe(422);

    const readBack = await agentA.get(`${INVOICES}/${invoice.id}`);
    expect(readBack.body.invoice.allocatedCents).toBe(0);
  });

  it('rejects a cross-tenant cash account with 422', async () => {
    const cashAccountBId = await accountId(orgB, '1110');

    const res = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId: cashAccountBId,
      customerId,
      allocations: [{ invoiceId: invoice.id, billId: null, amountCents: 40000 }],
    });

    expect(res.status).toBe(422);
  });
});
