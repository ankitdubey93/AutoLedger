import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * LedgerCore — AR/AP aging reports (Phase 3.9). Integration tier, real
 * PostgreSQL. Every case fixes `asOf` to 2026-09-04 so day-count math is
 * exact and reproducible.
 */

const app = createApp();
const AR_AGING = '/api/v1/ledger-core/reports/ar-aging';
const AP_AGING = '/api/v1/ledger-core/reports/ap-aging';
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const PAYMENTS = '/api/v1/ledger-core/payments';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';

const AS_OF = '2026-09-04';

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

async function issueInvoice(
  agent: Agent,
  orgId: string,
  customerId: string,
  totalCents: number,
  dueDate: string,
): Promise<string> {
  const revenueAccountId = await accountId(orgId, '4100');
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate: '2025-01-01',
    dueDate,
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'x', quantityMilli: 1000, unitPriceCents: totalCents, revenueAccountId, taxRateBp: 0 },
    ],
  });
  const invoiceId = created.body.invoice.id as string;
  await agent.post(`${INVOICES}/${invoiceId}/issue`).send({});
  return invoiceId;
}

async function approveBill(
  agent: Agent,
  orgId: string,
  vendorId: string,
  totalCents: number,
  dueDate: string,
  vendorReference: string,
): Promise<string> {
  const expenseAccountId = await accountId(orgId, '6130');
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference,
    billDate: '2026-06-01',
    dueDate,
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'x', quantityMilli: 1000, unitPriceCents: totalCents, expenseAccountId, taxRateBp: 0 },
    ],
  });
  const billId = created.body.bill.id as string;
  await agent.post(`${BILLS}/${billId}/submit`).send({});
  await agent.post(`${BILLS}/${billId}/approve`).send({});
  return billId;
}

let agentA: Agent;
let cashAccountId: string;
let customerId: string;
let vendorId: string;

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
});

afterAll(closePool);

describe('GET /ledger-core/reports/ar-aging', () => {
  it('a fresh org has an empty report with 5 zero buckets', async () => {
    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(5);
    expect(res.body.buckets.map((b: { bucket: string }) => b.bucket)).toEqual([
      'CURRENT',
      'D1_30',
      'D31_60',
      'D61_90',
      'D90_PLUS',
    ]);
    expect(res.body.totalOutstandingCents).toBe(0);
  });

  it('an invoice due in the future is CURRENT', async () => {
    await issueInvoice(agentA, orgA, customerId, 100000, '2026-10-01');

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    const current = res.body.buckets.find((b: { bucket: string }) => b.bucket === 'CURRENT');
    expect(current.amountCents).toBe(100000);
    expect(current.documentCount).toBe(1);
    expect(res.body.totalOutstandingCents).toBe(100000);
    expect(res.body.totalOverdueCents).toBe(0);
  });

  it('15 days past due falls in D1_30', async () => {
    await issueInvoice(agentA, orgA, customerId, 100000, '2026-08-20');

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    const bucket = res.body.buckets.find((b: { bucket: string }) => b.bucket === 'D1_30');
    expect(bucket.amountCents).toBe(100000);
    expect(res.body.totalOverdueCents).toBe(100000);
  });

  it('51 days past due falls in D31_60', async () => {
    await issueInvoice(agentA, orgA, customerId, 100000, '2026-07-15');

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    const bucket = res.body.buckets.find((b: { bucket: string }) => b.bucket === 'D31_60');
    expect(bucket.amountCents).toBe(100000);
  });

  it('86 days past due falls in D61_90', async () => {
    await issueInvoice(agentA, orgA, customerId, 100000, '2026-06-10');

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    const bucket = res.body.buckets.find((b: { bucket: string }) => b.bucket === 'D61_90');
    expect(bucket.amountCents).toBe(100000);
  });

  it('far in the past falls in D90_PLUS', async () => {
    await issueInvoice(agentA, orgA, customerId, 100000, '2026-01-01');

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    const bucket = res.body.buckets.find((b: { bucket: string }) => b.bucket === 'D90_PLUS');
    expect(bucket.amountCents).toBe(100000);
  });

  it('a partial payment reduces the outstanding amount for that invoice', async () => {
    const invoiceId = await issueInvoice(agentA, orgA, customerId, 100000, '2026-10-01');
    await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 40000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 40000 }],
    });

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    expect(res.body.totalOutstandingCents).toBe(60000);
  });

  it('a fully paid invoice is absent from every bucket', async () => {
    const invoiceId = await issueInvoice(agentA, orgA, customerId, 100000, '2026-10-01');
    await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: '2026-07-01',
      amountCents: 100000,
      cashAccountId,
      customerId,
      allocations: [{ invoiceId, billId: null, amountCents: 100000 }],
    });

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    expect(res.body.totalOutstandingCents).toBe(0);
    for (const bucket of res.body.buckets) {
      expect(bucket.amountCents).toBe(0);
    }
  });

  it('DRAFT and VOID invoices are absent', async () => {
    const revenueAccountId = await accountId(orgA, '4100');
    await agentA.post(INVOICES).send({
      customerId,
      issueDate: '2026-06-01',
      dueDate: '2026-10-01',
      notes: null,
      paymentTerms: null,
      lines: [
        { description: 'draft', quantityMilli: 1000, unitPriceCents: 5000, revenueAccountId, taxRateBp: 0 },
      ],
    });
    const voidedInvoiceId = await issueInvoice(agentA, orgA, customerId, 7000, '2026-10-01');
    await agentA.post(`${INVOICES}/${voidedInvoiceId}/void`).send({});

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    expect(res.body.totalOutstandingCents).toBe(0);
  });

  it('reconciles is true and controlAccount matches the receivable control account', async () => {
    await issueInvoice(agentA, orgA, customerId, 100000, '2026-10-01');

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    expect(res.body.controlAccount.code).toBe('1120');
    expect(res.body.controlAccount.balanceCents).toBe(res.body.totalOutstandingCents);
    expect(res.body.reconciles).toBe(true);
  });

  it('rows group two invoices for the same customer into one row', async () => {
    await issueInvoice(agentA, orgA, customerId, 60000, '2026-10-01');
    await issueInvoice(agentA, orgA, customerId, 40000, '2026-10-01');

    const res = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);

    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].totalCents).toBe(100000);
  });

  it('is readable by a VIEWER', async () => {
    const viewer = await createUserWithOrg({ label: 'eve', orgName: 'Org Eve' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const res = await agent.get(`${AR_AGING}?asOf=${AS_OF}`);
    expect(res.status).toBe(200);
  });

  it('rejects a malformed asOf', async () => {
    const res = await agentA.get(`${AR_AGING}?asOf=not-a-date`);
    expect(res.status).toBe(400);
  });

  it("never includes another org's invoices", async () => {
    await issueInvoice(agentA, orgA, customerId, 100000, '2026-10-01');

    const agentC = await loginAgent(app, userC);
    const customerCRes = await agentC.post(CUSTOMERS).send({ name: 'Bravo Customer' });
    await issueInvoice(agentC, orgB, customerCRes.body.customer.id as string, 5000, '2026-10-01');

    const resA = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);
    const resC = await agentC.get(`${AR_AGING}?asOf=${AS_OF}`);

    expect(resA.body.totalOutstandingCents).toBe(100000);
    expect(resC.body.totalOutstandingCents).toBe(5000);
  });
});

describe('GET /ledger-core/reports/ap-aging', () => {
  it('one approved bill reconciles to the payable control account', async () => {
    await approveBill(agentA, orgA, vendorId, 60000, '2026-10-01', 'VEND-AGE-1');

    const res = await agentA.get(`${AP_AGING}?asOf=${AS_OF}`);

    expect(res.body.controlAccount.code).toBe('2100');
    expect(res.body.totalOutstandingCents).toBe(60000);
    expect(res.body.reconciles).toBe(true);
  });
});
