import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Phase 26 — credit and debit notes as seen by everything that reads
 * settlement: the party ledger, party open items, AR/AP aging and the bank
 * matcher. The central claim is Phase 25's, extended: per party, ledger
 * closing = open-items outstanding, and across parties both = the control
 * account balance (`reconciles: true`) — including when a note leaves
 * unapplied credit, which is a NEGATIVE open item.
 */

const app = createApp();
const INVOICES = '/api/v1/ledger-core/invoices';
const BILLS = '/api/v1/ledger-core/bills';
const PAYMENTS = '/api/v1/ledger-core/payments';
const CUSTOMERS = '/api/v1/ledger-core/customers';
const VENDORS = '/api/v1/ledger-core/vendors';
const CREDIT_NOTES = '/api/v1/ledger-core/credit-notes';
const DEBIT_NOTES = '/api/v1/ledger-core/debit-notes';
const AR_AGING = '/api/v1/ledger-core/reports/ar-aging';
const AP_AGING = '/api/v1/ledger-core/reports/ap-aging';
const BANK_IMPORTS = '/api/v1/ledger-core/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/ledger-core/bank-transactions';

const DOC_DATE = '2026-09-01';
const DUE_DATE = '2026-12-31';
const NOTE_DATE = '2026-09-05';
const AS_OF = '2026-09-10';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let agentA: Agent;
let agentB: Agent;
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

async function issuedInvoice(totalCents: number, issueDate = DOC_DATE): Promise<{ id: string; number: string }> {
  const created = await agentA.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: DUE_DATE,
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'Kits', quantityMilli: 1000, unitPriceCents: totalCents, revenueAccountId: await accountId(orgA, '4100'), taxRateBp: 0 },
    ],
  });
  const id = created.body.invoice.id as string;
  const issued = await agentA.post(`${INVOICES}/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: invoice issue failed ${issued.status} ${issued.text}`);
  return { id, number: issued.body.invoice.invoiceNumber as string };
}

let billSequence = 0;

async function approvedBill(totalCents: number): Promise<string> {
  billSequence += 1;
  const created = await agentA.post(BILLS).send({
    vendorId,
    vendorReference: `GX-${String(billSequence)}`,
    billDate: DOC_DATE,
    dueDate: DUE_DATE,
    notes: null,
    paymentTerms: null,
    lines: [
      { description: 'Steel', quantityMilli: 1000, unitPriceCents: totalCents, expenseAccountId: await accountId(orgA, '5100'), taxRateBp: 0 },
    ],
  });
  const id = created.body.bill.id as string;
  await agentA.post(`${BILLS}/${id}/submit`).send({});
  const approved = await agentA.post(`${BILLS}/${id}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${approved.status} ${approved.text}`);
  return id;
}

async function receive(invoiceId: string, amountCents: number): Promise<void> {
  const res = await agentA.post(PAYMENTS).send({
    direction: 'RECEIVE',
    paymentDate: '2026-09-02',
    amountCents,
    cashAccountId: await accountId(orgA, '1110'),
    customerId,
    allocations: [{ invoiceId, billId: null, amountCents }],
  });
  if (res.status !== 201) throw new Error(`fixture: receipt failed ${res.status} ${res.text}`);
}

async function pay(billId: string, amountCents: number): Promise<void> {
  const res = await agentA.post(PAYMENTS).send({
    direction: 'PAY',
    paymentDate: '2026-09-02',
    amountCents,
    cashAccountId: await accountId(orgA, '1110'),
    vendorId,
    allocations: [{ invoiceId: null, billId, amountCents }],
  });
  if (res.status !== 201) throw new Error(`fixture: payment failed ${res.status} ${res.text}`);
}

async function creditNote(invoiceId: string, totalCents: number): Promise<string> {
  const created = await agentA.post(CREDIT_NOTES).send({
    invoiceId,
    issueDate: NOTE_DATE,
    reasonCode: 'PRICE_ADJUSTMENT',
    reason: null,
    notes: null,
    lines: [
      { description: 'Allowance', quantityMilli: 1000, unitPriceCents: totalCents, revenueAccountId: await accountId(orgA, '4800'), taxRateBp: 0 },
    ],
  });
  const id = created.body.creditNote.id as string;
  const issued = await agentA.post(`${CREDIT_NOTES}/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: credit note issue failed ${issued.status} ${issued.text}`);
  return id;
}

async function debitNote(billId: string, totalCents: number): Promise<string> {
  const created = await agentA.post(DEBIT_NOTES).send({
    billId,
    issueDate: NOTE_DATE,
    reasonCode: 'RETURN',
    reason: null,
    vendorCreditReference: null,
    notes: null,
    lines: [
      { description: 'Returned', quantityMilli: 1000, unitPriceCents: totalCents, expenseAccountId: await accountId(orgA, '5100'), taxRateBp: 0 },
    ],
  });
  const id = created.body.debitNote.id as string;
  const issued = await agentA.post(`${DEBIT_NOTES}/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: debit note issue failed ${issued.status} ${issued.text}`);
  return id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerId = (await agentA.post(CUSTOMERS).send({ name: 'Acme' })).body.customer.id as string;
  vendorId = (await agentA.post(VENDORS).send({ name: 'Globex' })).body.vendor.id as string;
});

afterAll(closePool);

describe('notes in the customer account and AR aging', () => {
  it('an unapplied credit note is a negative open item and AR still reconciles', async () => {
    const invoice = await issuedInvoice(110000);
    await receive(invoice.id, 110000);
    await creditNote(invoice.id, 22000);

    const open = await agentA.get(`${CUSTOMERS}/${customerId}/open-items?asOf=${AS_OF}`);
    expect(open.status).toBe(200);
    expect(open.body.outstandingCents).toBe(-22000);
    expect(open.body.overdueCents).toBe(0);
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items[0]).toMatchObject({
      documentKind: 'CREDIT_NOTE',
      documentNumber: 'CN-000001',
      baseOutstandingCents: -22000,
      bucket: 'CURRENT',
    });

    const aging = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);
    expect(aging.body.totalOutstandingCents).toBe(-22000);
    expect(aging.body.controlAccount.balanceCents).toBe(-22000);
    expect(aging.body.reconciles).toBe(true);
  });

  it('the customer ledger shows the credit note row and closes at the open-items total', async () => {
    const invoice = await issuedInvoice(110000);
    await receive(invoice.id, 110000);
    await creditNote(invoice.id, 22000);

    const ledger = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);
    const rows = ledger.body.rows as { kind: string; debitCents: number; creditCents: number }[];
    expect(rows.map((r) => r.kind)).toEqual(['INVOICE', 'PAYMENT', 'CREDIT_NOTE']);
    expect(rows[2]).toMatchObject({ debitCents: 0, creditCents: 22000 });
    expect(ledger.body.closingBalanceCents).toBe(-22000);
  });

  it('applying the credit to a new invoice clears the negative item and still reconciles', async () => {
    const paid = await issuedInvoice(110000);
    await receive(paid.id, 110000);
    const noteId = await creditNote(paid.id, 22000);
    const next = await issuedInvoice(50000, '2026-09-06');

    const applied = await agentA
      .post(`${CREDIT_NOTES}/${noteId}/allocations`)
      .send({ invoiceId: next.id, amountCents: 22000, allocationDate: '2026-09-06' });
    expect(applied.status).toBe(201);

    const open = await agentA.get(`${CUSTOMERS}/${customerId}/open-items?asOf=${AS_OF}`);
    expect(open.body.outstandingCents).toBe(28000);
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items[0]).toMatchObject({ documentKind: 'INVOICE', baseOutstandingCents: 28000 });

    const aging = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);
    expect(aging.body.totalOutstandingCents).toBe(28000);
    expect(aging.body.reconciles).toBe(true);
  });

  it('voiding an applied credit note restores both documents', async () => {
    const paid = await issuedInvoice(110000);
    await receive(paid.id, 110000);
    const noteId = await creditNote(paid.id, 22000);
    const next = await issuedInvoice(50000, '2026-09-06');
    await agentA
      .post(`${CREDIT_NOTES}/${noteId}/allocations`)
      .send({ invoiceId: next.id, amountCents: 22000, allocationDate: '2026-09-06' });

    const voided = await agentA.post(`${CREDIT_NOTES}/${noteId}/void`).send({ entryDate: '2026-09-07' });
    expect(voided.status).toBe(200);

    const open = await agentA.get(`${CUSTOMERS}/${customerId}/open-items?asOf=${AS_OF}`);
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items[0]).toMatchObject({ documentKind: 'INVOICE', baseOutstandingCents: 50000 });

    const aging = await agentA.get(`${AR_AGING}?asOf=${AS_OF}`);
    expect(aging.body.reconciles).toBe(true);

    const ledger = await agentA.get(`${CUSTOMERS}/${customerId}/ledger`);
    const rows = ledger.body.rows as { kind: string; debitCents: number }[];
    const voidRow = rows.find((r) => r.kind === 'CREDIT_NOTE_VOID');
    expect(voidRow?.debitCents).toBe(22000);
  });
});

describe('notes in the vendor account and AP aging', () => {
  it('vendor side mirrors it', async () => {
    const billId = await approvedBill(110000);
    await pay(billId, 110000);
    await debitNote(billId, 22000);

    const open = await agentA.get(`${VENDORS}/${vendorId}/open-items?asOf=${AS_OF}`);
    expect(open.body.outstandingCents).toBe(-22000);
    expect(open.body.items[0]).toMatchObject({ documentKind: 'DEBIT_NOTE', documentNumber: 'DN-000001' });

    const aging = await agentA.get(`${AP_AGING}?asOf=${AS_OF}`);
    expect(aging.body.totalOutstandingCents).toBe(-22000);
    expect(aging.body.reconciles).toBe(true);

    const ledger = await agentA.get(`${VENDORS}/${vendorId}/ledger`);
    const rows = ledger.body.rows as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(['BILL', 'PAYMENT', 'DEBIT_NOTE']);
    expect(ledger.body.closingBalanceCents).toBe(-22000);
  });
});

describe('bank matching sees the credited amount due', () => {
  it('bank matching suggests the credited amount due', async () => {
    const invoice = await issuedInvoice(110000);
    await creditNote(invoice.id, 22000);
    const cashAccountId = await accountId(orgA, '1110');
    const description = `PAYMENT RECEIVED ${invoice.number}`;

    const imported = await agentA.post(BANK_IMPORTS).send({
      accountId: cashAccountId,
      fileName: 'net.csv',
      content: `Date,Description,Amount\n${DOC_DATE},${description},880.00`,
      dateFormat: 'ISO',
    });
    expect(imported.status).toBe(201);

    const list = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cashAccountId}&status=UNMATCHED&limit=100`);
    const txn = (list.body.transactions as { id: string; description: string }[]).find(
      (t) => t.description === description,
    );
    if (txn === undefined) throw new Error('fixture: imported line not found');
    const detail = await agentA.get(`${BANK_TRANSACTIONS}/${txn.id}`);
    const suggestion = (detail.body.transaction.suggestions as { id: string; invoiceId: string | null; score: number }[])[0];
    expect(suggestion?.invoiceId).toBe(invoice.id);
    expect(suggestion?.score).toBe(100);

    const matched = await agentA.post(`${BANK_TRANSACTIONS}/${txn.id}/match`).send({ suggestionId: suggestion?.id });
    expect(matched.status).toBe(200);
    const after = (await agentA.get(`${INVOICES}/${invoice.id}`)).body.invoice;
    expect(after.settlementStatus).toBe('PAID');
    expect(after.amountDueCents).toBe(0);
  });
});

describe('notes — cross-tenant isolation', () => {
  it("org B's aging and open items never include org A's notes", async () => {
    const invoice = await issuedInvoice(110000);
    await receive(invoice.id, 110000);
    await creditNote(invoice.id, 22000);

    const agingB = await agentB.get(`${AR_AGING}?asOf=${AS_OF}`);
    expect(agingB.body.totalOutstandingCents).toBe(0);

    const openB = await agentB.get(`${CUSTOMERS}/${customerId}/open-items?asOf=${AS_OF}`);
    expect(openB.status).toBe(404);
  });
});
