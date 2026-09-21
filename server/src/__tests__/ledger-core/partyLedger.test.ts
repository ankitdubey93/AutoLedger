import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — customer and vendor accounts (Phase 25). Integration tier,
 * real PostgreSQL. The central claim: per party, the ledger's closing balance
 * equals its open-items outstanding, and across parties both equal the
 * control account's GL balance.
 */

const app = createApp();
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const PAYMENTS = '/api/v1/ledger-core/payments';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const AR_AGING = '/api/v1/ledger-core/reports/ar-aging';
const AP_AGING = '/api/v1/ledger-core/reports/ap-aging';

const AS_OF = '2026-09-04';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;
let cashAccountId: string;
let customerId: string;
let vendorId: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function draftInvoice(
  agent: Agent,
  orgId: string,
  forCustomerId: string,
  totalCents: number,
  issueDate: string,
  dueDate: string,
): Promise<string> {
  const revenueAccountId = await accountId(orgId, '4100');
  const created = await agent.post(INVOICES).send({
    customerId: forCustomerId,
    issueDate,
    dueDate,
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'x', quantityMilli: 1000, unitPriceCents: totalCents, revenueAccountId, taxRateBp: 0 },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: invoice create failed ${created.status}`);
  return created.body.invoice.id as string;
}

async function issueInvoice(
  agent: Agent,
  orgId: string,
  forCustomerId: string,
  totalCents: number,
  issueDate = '2026-06-01',
  dueDate = '2026-10-01',
): Promise<{ id: string; number: string }> {
  const id = await draftInvoice(agent, orgId, forCustomerId, totalCents, issueDate, dueDate);
  const issued = await agent.post(`${INVOICES}/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: invoice issue failed ${issued.status}`);
  return { id, number: issued.body.invoice.invoiceNumber as string };
}

async function approveBill(
  agent: Agent,
  orgId: string,
  forVendorId: string,
  totalCents: number,
  vendorReference: string,
): Promise<string> {
  const expenseAccountId = await accountId(orgId, '6130');
  const created = await agent.post(BILLS).send({
    vendorId: forVendorId,
    vendorReference,
    billDate: '2026-06-01',
    dueDate: '2026-10-01',
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'x', quantityMilli: 1000, unitPriceCents: totalCents, expenseAccountId, taxRateBp: 0 },
    ],
  });
  const billId = created.body.bill.id as string;
  await agent.post(`${BILLS}/${billId}/submit`).send({});
  const approved = await agent.post(`${BILLS}/${billId}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${approved.status}`);
  return billId;
}

async function receive(
  agent: Agent,
  forCustomerId: string,
  paymentDate: string,
  allocations: { invoiceId: string; amountCents: number }[],
): Promise<string> {
  const res = await agent.post(PAYMENTS).send({
    direction: 'RECEIVE',
    paymentDate,
    amountCents: allocations.reduce((sum, a) => sum + a.amountCents, 0),
    cashAccountId,
    customerId: forCustomerId,
    reference: 'RCPT-1',
    allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, billId: null, amountCents: a.amountCents })),
  });
  if (res.status !== 201) throw new Error(`fixture: payment failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.payment.id as string;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'party-a', orgName: 'Party Org A' });
  userB = await createUserWithOrg({ label: 'party-b', orgName: 'Party Org B' });
  orgA = userA.orgId;
  orgB = userB.orgId;

  agentA = await loginAgent(app, userA);
  cashAccountId = await accountId(orgA, '1110');

  const customerRes = await agentA.post(CUSTOMERS).send({ name: 'Northwind Traders' });
  customerId = customerRes.body.customer.id as string;
  const vendorRes = await agentA.post(VENDORS).send({ name: 'Acme Supplies' });
  vendorId = vendorRes.body.vendor.id as string;
});

afterAll(closePool);

describe('GET /customers/:id/ledger', () => {
  it('issue 10000 → one INVOICE row, debit 10000, runningBalance 10000, closing 10000', async () => {
    const invoice = await issueInvoice(agentA, orgA, customerId, 10000);

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);

    expect(res.status).toBe(200);
    expect(res.body.party).toEqual({ kind: 'CUSTOMER', id: customerId, name: 'Northwind Traders' });
    expect(res.body.controlAccount.code).toBe('1120');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      kind: 'INVOICE',
      documentId: invoice.id,
      documentNumber: invoice.number,
      debitCents: 10000,
      creditCents: 0,
      runningBalanceCents: 10000,
      allocations: [],
    });
    expect(res.body.closingBalanceCents).toBe(10000);
  });

  it('partial RECEIVE of 4000 → PAYMENT row credit 4000, running 6000, one allocation', async () => {
    const invoice = await issueInvoice(agentA, orgA, customerId, 10000);
    const paymentId = await receive(agentA, customerId, '2026-07-01', [{ invoiceId: invoice.id, amountCents: 4000 }]);

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);

    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[1]).toMatchObject({
      kind: 'PAYMENT',
      documentId: paymentId,
      documentNumber: 'RCPT-1',
      debitCents: 0,
      creditCents: 4000,
      runningBalanceCents: 6000,
      allocations: [{ documentId: invoice.id, documentNumber: invoice.number, baseAmountCents: 4000 }],
    });
    expect(res.body.closingBalanceCents).toBe(6000);
  });

  it('one payment across two invoices (3000 + 2000) → ONE PAYMENT row, credit 5000, two allocations', async () => {
    const first = await issueInvoice(agentA, orgA, customerId, 3000);
    const second = await issueInvoice(agentA, orgA, customerId, 2000);
    await receive(agentA, customerId, '2026-07-01', [
      { invoiceId: first.id, amountCents: 3000 },
      { invoiceId: second.id, amountCents: 2000 },
    ]);

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);
    const payments = (res.body.rows as Array<{ kind: string; creditCents: number; allocations: unknown[] }>).filter(
      (r) => r.kind === 'PAYMENT',
    );

    expect(payments).toHaveLength(1);
    expect(payments[0]?.creditCents).toBe(5000);
    expect(payments[0]?.allocations).toHaveLength(2);
    expect(res.body.closingBalanceCents).toBe(0);
  });

  it('void the payment → PAYMENT_VOID row debit 4000, closing back to 10000', async () => {
    const invoice = await issueInvoice(agentA, orgA, customerId, 10000);
    const paymentId = await receive(agentA, customerId, '2026-07-01', [{ invoiceId: invoice.id, amountCents: 4000 }]);
    const voided = await agentA.post(`${PAYMENTS}/${paymentId}/void`).send({});
    expect(voided.status).toBe(200);

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);
    const voidRow = (res.body.rows as Array<{ kind: string; debitCents: number; allocations: unknown[] }>).find(
      (r) => r.kind === 'PAYMENT_VOID',
    );

    expect(voidRow?.debitCents).toBe(4000);
    expect(voidRow?.allocations).toHaveLength(1);
    expect(res.body.closingBalanceCents).toBe(10000);
  });

  it('issue then void an unpaid invoice → INVOICE debit and INVOICE_VOID credit, closing 0', async () => {
    const invoice = await issueInvoice(agentA, orgA, customerId, 7000);
    const voided = await agentA.post(`${INVOICES}/${invoice.id}/void`).send({});
    expect(voided.status).toBe(200);

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);
    const kinds = (res.body.rows as Array<{ kind: string; debitCents: number; creditCents: number }>).map((r) => [
      r.kind,
      r.debitCents,
      r.creditCents,
    ]);

    expect(kinds).toEqual([
      ['INVOICE', 7000, 0],
      ['INVOICE_VOID', 0, 7000],
    ]);
    expect(res.body.closingBalanceCents).toBe(0);
  });

  it('a DRAFT invoice produces no row', async () => {
    await draftInvoice(agentA, orgA, customerId, 5000, '2026-06-01', '2026-10-01');

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);

    expect(res.body.rows).toHaveLength(0);
    expect(res.body.closingBalanceCents).toBe(0);
  });

  it('from/to window: openingBalanceCents is the sum before from; rows only inside the window', async () => {
    await issueInvoice(agentA, orgA, customerId, 1000, '2026-05-01');
    await issueInvoice(agentA, orgA, customerId, 2000, '2026-06-15');
    await issueInvoice(agentA, orgA, customerId, 4000, '2026-08-01');

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger?from=2026-06-01&to=2026-06-30`);

    expect(res.body.openingBalanceCents).toBe(1000);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].debitCents).toBe(2000);
    expect(res.body.rows[0].runningBalanceCents).toBe(3000);
    expect(res.body.closingBalanceCents).toBe(3000);
    expect(res.body.totalCount).toBe(1);
  });

  it("another customer's invoices never appear", async () => {
    const otherRes = await agentA.post(CUSTOMERS).send({ name: 'Contoso' });
    const otherId = otherRes.body.customer.id as string;
    await issueInvoice(agentA, orgA, customerId, 1000);
    await issueInvoice(agentA, orgA, otherId, 9000);

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);

    expect(res.body.rows).toHaveLength(1);
    expect(res.body.closingBalanceCents).toBe(1000);
  });

  it('a VIEWER can read both endpoints → 200', async () => {
    const viewer = await createUserWithOrg({ label: 'party-viewer', orgName: 'Viewer Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    expect((await agent.get(`${CUSTOMERS}/${customerId}/ledger`)).status).toBe(200);
    expect((await agent.get(`${CUSTOMERS}/${customerId}/open-items`)).status).toBe(200);
  });

  it('malformed from → 400', async () => {
    const res = await agentA.get(`${CUSTOMERS}/${customerId}/ledger?from=not-a-date`);
    expect(res.status).toBe(400);
  });
});

describe('GET /vendors/:id/ledger', () => {
  it('approved bill 7000 → BILL row credit 7000, running 7000 (credit-normal positive); PAY 7000 → closing 0', async () => {
    const billId = await approveBill(agentA, orgA, vendorId, 7000, 'ACME-77');

    const before = await agentA.get(`${VENDORS}/${vendorId}/ledger`);
    expect(before.body.controlAccount.code).toBe('2100');
    expect(before.body.rows[0]).toMatchObject({
      kind: 'BILL',
      documentId: billId,
      documentNumber: 'ACME-77',
      debitCents: 0,
      creditCents: 7000,
      runningBalanceCents: 7000,
    });

    const paid = await agentA.post(PAYMENTS).send({
      direction: 'PAY',
      paymentDate: '2026-07-01',
      amountCents: 7000,
      cashAccountId,
      vendorId,
      allocations: [{ invoiceId: null, billId, amountCents: 7000 }],
    });
    expect(paid.status).toBe(201);

    const after = await agentA.get(`${VENDORS}/${vendorId}/ledger`);
    expect(after.body.rows[1]).toMatchObject({ kind: 'PAYMENT', debitCents: 7000, runningBalanceCents: 0 });
    expect(after.body.rows[1].allocations[0].documentNumber).toBe('ACME-77');
    expect(after.body.closingBalanceCents).toBe(0);
  });
});

describe('GET /customers/:id/open-items and /vendors/:id/open-items', () => {
  it('only outstanding > 0 documents; daysOverdue 15 for due 2026-08-20 at asOf 2026-09-04, bucket D1_30', async () => {
    const overdue = await issueInvoice(agentA, orgA, customerId, 5000, '2026-07-01', '2026-08-20');
    const paidOff = await issueInvoice(agentA, orgA, customerId, 3000, '2026-07-01', '2026-10-01');
    await receive(agentA, customerId, '2026-07-15', [{ invoiceId: paidOff.id, amountCents: 3000 }]);
    await issueInvoice(agentA, orgA, customerId, 2000, '2026-07-01', '2026-10-01');

    const res = await agentA.get(`${CUSTOMERS}/${customerId}/open-items?asOf=${AS_OF}`);

    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe(AS_OF);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      documentId: overdue.id,
      documentNumber: overdue.number,
      dueDate: '2026-08-20',
      baseOutstandingCents: 5000,
      daysOverdue: 15,
      bucket: 'D1_30',
    });
    expect(res.body.items[1]).toMatchObject({ daysOverdue: 0, bucket: 'CURRENT' });
    expect(res.body.outstandingCents).toBe(7000);
    expect(res.body.overdueCents).toBe(5000);
  });

  it('vendor open items list the approved, unpaid bill', async () => {
    await approveBill(agentA, orgA, vendorId, 6000, 'ACME-1');

    const res = await agentA.get(`${VENDORS}/${vendorId}/open-items?asOf=${AS_OF}`);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].documentNumber).toBe('ACME-1');
    expect(res.body.outstandingCents).toBe(6000);
  });
});

describe('subledger ties to the GL', () => {
  it('per customer, ledger closing === open-items outstanding; their sum === ar-aging total === control balance', async () => {
    const otherRes = await agentA.post(CUSTOMERS).send({ name: 'Contoso' });
    const otherId = otherRes.body.customer.id as string;

    const a1 = await issueInvoice(agentA, orgA, customerId, 10000);
    await issueInvoice(agentA, orgA, customerId, 2500);
    await receive(agentA, customerId, '2026-07-01', [{ invoiceId: a1.id, amountCents: 4000 }]);
    const b1 = await issueInvoice(agentA, orgA, otherId, 8000);
    const voidedPayment = await receive(agentA, otherId, '2026-07-02', [{ invoiceId: b1.id, amountCents: 8000 }]);
    await agentA.post(`${PAYMENTS}/${voidedPayment}/void`).send({});
    const voidedInvoice = await issueInvoice(agentA, orgA, otherId, 999);
    await agentA.post(`${INVOICES}/${voidedInvoice.id}/void`).send({});

    let sum = 0;
    for (const id of [customerId, otherId]) {
      const ledgerRes = await agentA.get(`${CUSTOMERS}/${id}/ledger?to=${AS_OF}`);
      const openRes = await agentA.get(`${CUSTOMERS}/${id}/open-items?asOf=${AS_OF}`);
      expect(ledgerRes.body.closingBalanceCents).toBe(openRes.body.outstandingCents);
      sum += ledgerRes.body.closingBalanceCents as number;
    }

    const aging = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);
    expect(sum).toBe(8500 + 8000);
    expect(sum).toBe(aging.body.totalOutstandingCents);
    expect(sum).toBe(aging.body.controlAccount.balanceCents);
    expect(aging.body.reconciles).toBe(true);
  });

  it('per vendor, ledger closing === open-items outstanding; their sum === ap-aging total === control balance', async () => {
    const otherRes = await agentA.post(VENDORS).send({ name: 'Globex' });
    const otherId = otherRes.body.vendor.id as string;

    const bill = await approveBill(agentA, orgA, vendorId, 5000, 'ACME-A');
    await approveBill(agentA, orgA, otherId, 3000, 'GLOBEX-1');
    await agentA.post(PAYMENTS).send({
      direction: 'PAY',
      paymentDate: '2026-07-01',
      amountCents: 2000,
      cashAccountId,
      vendorId,
      allocations: [{ invoiceId: null, billId: bill, amountCents: 2000 }],
    });

    let sum = 0;
    for (const id of [vendorId, otherId]) {
      const ledgerRes = await agentA.get(`${VENDORS}/${id}/ledger?to=${AS_OF}`);
      const openRes = await agentA.get(`${VENDORS}/${id}/open-items?asOf=${AS_OF}`);
      expect(ledgerRes.body.closingBalanceCents).toBe(openRes.body.outstandingCents);
      sum += ledgerRes.body.closingBalanceCents as number;
    }

    const aging = await agentA.get(`${AP_AGING}?asOf=${AS_OF}`);
    expect(sum).toBe(6000);
    expect(sum).toBe(aging.body.totalOutstandingCents);
    expect(sum).toBe(aging.body.controlAccount.balanceCents);
    expect(aging.body.reconciles).toBe(true);
  });
});

describe('cross-tenant isolation', () => {
  it("org B's customer and vendor are 404 under org A's token on all four routes, and org B is untouched", async () => {
    const agentB = await loginAgent(app, userB);
    const customerB = (await agentB.post(CUSTOMERS).send({ name: 'Bravo Customer' })).body.customer.id as string;
    const vendorB = (await agentB.post(VENDORS).send({ name: 'Bravo Vendor' })).body.vendor.id as string;
    await issueInvoice(agentB, orgB, customerB, 4200);

    for (const path of [`${CUSTOMERS}/${customerB}/ledger`, `${CUSTOMERS}/${customerB}/open-items`]) {
      const res = await agentA.get(path);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Customer not found');
    }
    for (const path of [`${VENDORS}/${vendorB}/ledger`, `${VENDORS}/${vendorB}/open-items`]) {
      const res = await agentA.get(path);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Vendor not found');
    }

    const stillB = await agentB.get(`${CUSTOMERS}/${customerB}/ledger`);
    expect(stillB.body.closingBalanceCents).toBe(4200);
  });
});
