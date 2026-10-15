import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, issueInvoice, type Agent } from '../helpers/accountingFixtures.js';
import {
  accountOwnBalance,
  applyDepositRequest,
  confirmedOrder,
  createVendor,
  isoDaysFromNow,
  issuedDeposit,
  issuedFinalDocument,
  journalLines,
  payDocument,
  requestDeposit,
  TODAY,
} from '../helpers/depositFixtures.js';

/**
 * Phase 42 (Slice G) — deposits and prepayments against orders. Integration
 * tier, real PostgreSQL. (The org's base currency is USD; the plan's "INR" is
 * nominal.) Order total throughout: 1,000.00 = 100000 cents.
 *
 * The central claims: a deposit is a contract liability (2130) / a prepayment
 * asset (1150), applied only up to what has been PAID and not yet applied;
 * the application is the third settlement source, so the final document's
 * amount due, aging, party ledgers and statements all agree with the GL; and
 * none of it crosses tenants.
 */

const app = createApp();
const INVOICES = '/api/v1/invoices';
const BILLS = '/api/v1/bills';
const CUSTOMERS = '/api/v1/customers';
const AR_AGING = '/api/v1/reports/ar-aging';

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;
let customerA: string;
let vendorA: string;

async function getInvoice(id: string) {
  const res = await agentA.get(`${INVOICES}/${id}`);
  expect(res.status).toBe(200);
  return res.body.invoice as {
    kind: string;
    status: string;
    totalCents: number;
    taxCents: number;
    amountDueCents: number;
    depositAppliedCents: number;
    journalEntryId: string | null;
    lines: { revenueAccountId: string; taxRateBp: number }[];
    depositApplications: { id: string; status: string }[];
  };
}

async function getBill(id: string) {
  const res = await agentA.get(`${BILLS}/${id}`);
  expect(res.status).toBe(200);
  return res.body.bill as { kind: string; amountDueCents: number; lines: { expenseAccountId: string }[] };
}

/** Order -> issued 300.00 deposit invoice, paid in full -> issued final invoice of 1,000.00. */
async function paidDepositAndFinal(depositCents = 30_000) {
  const order = await confirmedOrder(agentA, userA.orgId, 'SALES', customerA);
  const deposit = await issuedDeposit(agentA, 'SALES', order.id, { amountCents: depositCents });
  const paymentId = await payDocument(agentA, userA.orgId, 'SALES', customerA, deposit, depositCents);
  const final = await issuedFinalDocument(agentA, 'SALES', order.id);
  return { order, deposit, paymentId, final };
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  customerA = await createCustomer(agentA, 'Acme Fitouts', 'buyer@acme.test');
  vendorA = await createVendor(agentA, 'Steel Co');
});

afterAll(closePool);

describe('deposits — sales', () => {
  it('1. a 30% deposit on a confirmed order -> DRAFT DEPOSIT invoice of 300.00 on 2130, tax 0', async () => {
    const order = await confirmedOrder(agentA, userA.orgId, 'SALES', customerA);
    const res = await requestDeposit(agentA, 'SALES', order.id, { percentBp: 3000 });
    expect(res.status).toBe(201);
    expect(res.body.document.kind).toBe('INVOICE');

    const invoice = await getInvoice(res.body.document.id as string);
    expect(invoice).toMatchObject({ kind: 'DEPOSIT', status: 'DRAFT', totalCents: 30000, taxCents: 0 });
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]).toMatchObject({
      revenueAccountId: await accountId(userA.orgId, '2130'),
      taxRateBp: 0,
    });
  });

  it('2. issuing it posts DR 1120 300.00 / CR 2130 300.00', async () => {
    const order = await confirmedOrder(agentA, userA.orgId, 'SALES', customerA);
    const id = await issuedDeposit(agentA, 'SALES', order.id, { percentBp: 3000 });
    const invoice = await getInvoice(id);
    expect(invoice.status).toBe('ISSUED');
    expect(await journalLines(userA.orgId, invoice.journalEntryId!)).toEqual([
      { code: '1120', debit: 30000, credit: 0 },
      { code: '2130', debit: 0, credit: 30000 },
    ]);
  });

  it('3. a second deposit pushing the total over the order -> 422', async () => {
    const order = await confirmedOrder(agentA, userA.orgId, 'SALES', customerA);
    expect((await requestDeposit(agentA, 'SALES', order.id, { percentBp: 3000 })).status).toBe(201);
    const over = await requestDeposit(agentA, 'SALES', order.id, { amountCents: 80_000 });
    expect(over.status).toBe(422);
    expect(over.text).toContain('Deposits on this order would exceed its total');
    // Exactly the remainder is allowed.
    expect((await requestDeposit(agentA, 'SALES', order.id, { amountCents: 70_000 })).status).toBe(201);
  });

  it('4. applying before any payment -> 422 Only 0.00 of this deposit has been received', async () => {
    const order = await confirmedOrder(agentA, userA.orgId, 'SALES', customerA);
    const deposit = await issuedDeposit(agentA, 'SALES', order.id, { amountCents: 30_000 });
    const final = await issuedFinalDocument(agentA, 'SALES', order.id);
    const res = await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000);
    expect(res.status).toBe(422);
    expect(res.text).toContain('Only 0.00 of this deposit has been received');
  });

  it("5. after a 300.00 payment, applying 300.00 posts DR 2130 / CR 1120 and the final invoice's amountDue drops by 300.00", async () => {
    const { deposit, final } = await paidDepositAndFinal();
    expect((await getInvoice(final)).amountDueCents).toBe(100_000);

    const res = await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000);
    expect(res.status).toBe(201);
    expect(res.body.application).toMatchObject({ direction: 'SALES', amountCents: 30000, status: 'POSTED' });
    expect(await journalLines(userA.orgId, res.body.application.journalEntryId as string)).toEqual([
      { code: '1120', debit: 0, credit: 30000 },
      { code: '2130', debit: 30000, credit: 0 },
    ]);

    const after = await getInvoice(final);
    expect(after.amountDueCents).toBe(70_000);
    expect(after.depositAppliedCents).toBe(30_000);
    expect(after.depositApplications).toEqual([expect.objectContaining({ status: 'POSTED' })]);

    // Cannot apply more than has been paid and not yet applied.
    const again = await applyDepositRequest(agentA, 'SALES', final, deposit, 1);
    expect(again.status).toBe(422);
    expect(again.text).toContain('Only 0.00 of this deposit has been received and not yet applied');
  });

  it('6. 2130 returns to 0.00; AR control balance = sum of party open items = aging total', async () => {
    const { deposit, final } = await paidDepositAndFinal();
    expect((await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000)).status).toBe(201);

    expect(await accountOwnBalance(agentA, userA.orgId, '2130')).toBe(0);

    const ledger = await agentA.get(`${CUSTOMERS}/${customerA}/ledger?to=${TODAY}`);
    const open = await agentA.get(`${CUSTOMERS}/${customerA}/open-items?asOf=${TODAY}`);
    expect(ledger.body.closingBalanceCents).toBe(open.body.outstandingCents);
    expect(open.body.outstandingCents).toBe(70_000);

    const aging = await agentA.get(`${AR_AGING}?asOf=${TODAY}`);
    expect(aging.body.totalOutstandingCents).toBe(70_000);
    expect(aging.body.controlAccount.balanceCents).toBe(70_000);
    expect(aging.body.reconciles).toBe(true);
  });

  it('7. the customer statement (Outstanding, as at today) shows the final invoice net of the deposit', async () => {
    const { final } = await paidDepositAndFinal().then(async (s) => {
      expect((await applyDepositRequest(agentA, 'SALES', s.final, s.deposit, 30_000)).status).toBe(201);
      return s;
    });
    const res = await agentA.get(`/api/v1/statements/customers/${customerA}?type=OUTSTANDING&asOf=${TODAY}`);
    expect(res.status).toBe(200);
    const statement = res.body.statement;
    const items = statement.openItems as { documentId: string; baseOutstandingCents: number }[];
    expect(items.find((i) => i.documentId === final)?.baseOutstandingCents).toBe(70_000);
    expect(statement.outstandingCents).toBe(70_000);
    expect(statement.closingBalanceCents).toBe(70_000);
  });

  it('8. voiding the application reverses the journal and restores amountDue', async () => {
    const { deposit, final } = await paidDepositAndFinal();
    const applied = await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000);
    const application = applied.body.application as { id: string };

    const voided = await agentA.post(`/api/v1/deposit-applications/sales/${application.id}/void`).send({});
    expect(voided.status).toBe(200);
    expect(voided.body.application.status).toBe('VOID');
    const reversalId = voided.body.application.voidJournalEntryId as string;
    expect(await journalLines(userA.orgId, reversalId)).toEqual([
      { code: '1120', debit: 30000, credit: 0 },
      { code: '2130', debit: 0, credit: 30000 },
    ]);
    // The reversal copies the original entry's source type (reverseEntryOnClient).
    const { rows } = await pool.query<{ source_type: string }>(
      'SELECT source_type FROM journal_entries WHERE id = $1 AND org_id = $2',
      [reversalId, userA.orgId],
    );
    expect(rows[0]?.source_type).toBe('deposit_application');

    const after = await getInvoice(final);
    expect(after.amountDueCents).toBe(100_000);
    expect(after.depositAppliedCents).toBe(0);

    const again = await agentA.post(`/api/v1/deposit-applications/sales/${application.id}/void`).send({});
    expect(again.status).toBe(409);
    expect(again.text).toContain('already been voided');

    // The deposit is available again.
    expect((await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000)).status).toBe(201);
  });

  it('9. the deposit invoice cannot be voided while an application is POSTED -> 409', async () => {
    const { deposit, final } = await paidDepositAndFinal();
    expect((await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000)).status).toBe(201);

    const onDeposit = await agentA.post(`${INVOICES}/${deposit}/void`).send({});
    expect(onDeposit.status).toBe(409);
    // A paid deposit hits the payments guard first; either way it cannot be voided.
    expect(onDeposit.text).toMatch(/Void the (payments|deposit applications)/);
    const onTarget = await agentA.post(`${INVOICES}/${final}/void`).send({});
    expect(onTarget.status).toBe(409);
    expect(onTarget.text).toContain('Void the deposit applications on this invoice first');
  });

  it('10. applying to an invoice not linked to the order -> 422 This deposit belongs to a different order', async () => {
    const order = await confirmedOrder(agentA, userA.orgId, 'SALES', customerA);
    const deposit = await issuedDeposit(agentA, 'SALES', order.id, { amountCents: 30_000 });
    await payDocument(agentA, userA.orgId, 'SALES', customerA, deposit, 30_000);
    const unrelated = await issueInvoice(agentA, userA.orgId, customerA, 50_000, TODAY, isoDaysFromNow(30));

    const res = await applyDepositRequest(agentA, 'SALES', unrelated.id, deposit, 30_000);
    expect(res.status).toBe(422);
    expect(res.text).toContain('This deposit belongs to a different order');
  });

  it('11. a foreign-currency order -> 422 Deposits are available on base-currency orders only', async () => {
    const order = await confirmedOrder(agentA, userA.orgId, 'SALES', customerA, 100_000, 'EUR');
    const res = await requestDeposit(agentA, 'SALES', order.id, { percentBp: 3000 });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Deposits are available on base-currency orders only');
  });
});

describe('deposits — purchase', () => {
  it('12. a prepayment bill on 1150, applied to the final bill -> DR 2100 / CR 1150', async () => {
    const order = await confirmedOrder(agentA, userA.orgId, 'PURCHASE', vendorA, 100_000);
    const prepayment = await issuedDeposit(agentA, 'PURCHASE', order.id, { amountCents: 30_000 });
    const bill = await getBill(prepayment);
    expect(bill.kind).toBe('DEPOSIT');
    expect(bill.lines[0]?.expenseAccountId).toBe(await accountId(userA.orgId, '1150'));

    await payDocument(agentA, userA.orgId, 'PURCHASE', vendorA, prepayment, 30_000);
    const final = await issuedFinalDocument(agentA, 'PURCHASE', order.id);
    expect((await getBill(final)).amountDueCents).toBe(100_000);

    const res = await applyDepositRequest(agentA, 'PURCHASE', final, prepayment, 30_000);
    expect(res.status).toBe(201);
    expect(res.body.application.direction).toBe('PURCHASE');
    expect(await journalLines(userA.orgId, res.body.application.journalEntryId as string)).toEqual([
      { code: '1150', debit: 0, credit: 30000 },
      { code: '2100', debit: 30000, credit: 0 },
    ]);
    expect((await getBill(final)).amountDueCents).toBe(70_000);

    const voided = await agentA.post(`/api/v1/deposit-applications/purchase/${res.body.application.id as string}/void`).send({});
    expect(voided.status).toBe(200);
    expect((await getBill(final)).amountDueCents).toBe(100_000);
  });
});

describe('deposits — from a quote', () => {
  it('13. a quote with depositPercentBp 2500 converted to ORDER creates the DRAFT deposit invoice of 25%; converting to INVOICE -> 422', async () => {
    const created = await agentA.post('/api/v1/quotes').send({
      partyId: customerA,
      quoteDate: TODAY,
      validUntil: isoDaysFromNow(30),
      depositPercentBp: 2500,
      lines: [
        {
          description: 'Installation',
          quantityMilli: 2000,
          unitPriceCents: 10000,
          accountId: await accountId(userA.orgId, '4100'),
          taxRateBp: 0,
        },
      ],
    });
    expect(created.status).toBe(201);
    const quoteId = created.body.quote.id as string;
    expect((await agentA.post(`/api/v1/quotes/${quoteId}/send`).send({ delivery: 'MANUAL' })).status).toBe(200);
    expect((await agentA.post(`/api/v1/quotes/${quoteId}/accept`).send({ signerName: 'Jane Doe' })).status).toBe(200);

    const asInvoice = await agentA.post(`/api/v1/quotes/${quoteId}/convert`).send({ target: 'INVOICE' });
    expect(asInvoice.status).toBe(422);
    expect(asInvoice.text).toContain('This quote asks for a deposit');

    const asOrder = await agentA.post(`/api/v1/quotes/${quoteId}/convert`).send({ target: 'ORDER' });
    expect(asOrder.status).toBe(201);
    const order = (await agentA.get(`/api/v1/orders/${asOrder.body.document.id as string}`)).body.order as {
      documents: { kind: string; id: string; status: string }[];
    };
    const deposit = order.documents.find((d) => d.kind === 'INVOICE');
    expect(deposit).toMatchObject({ status: 'DRAFT' });
    expect(await getInvoice(deposit!.id)).toMatchObject({ kind: 'DEPOSIT', totalCents: 5000 }); // 25% of 200.00
  });
});

describe('deposits — tenancy, integrity, payment voids', () => {
  it("14. cross-tenant: org B applying org A's deposit -> 404; org B cannot void org A's application -> 404", async () => {
    const { deposit, final } = await paidDepositAndFinal();
    const applied = await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000);
    const applicationId = applied.body.application.id as string;

    // B naming A's target invoice.
    expect((await applyDepositRequest(agentB, 'SALES', final, deposit, 1_000)).status).toBe(404);
    // B's own invoice naming A's deposit document.
    const customerB = await createCustomer(agentB, 'Bravo Buyer', 'b@bravo.test');
    const own = await issueInvoice(agentB, userB.orgId, customerB, 50_000, TODAY, isoDaysFromNow(30));
    const res = await applyDepositRequest(agentB, 'SALES', own.id, deposit, 1_000);
    expect(res.status).toBe(404);
    // B cannot request a deposit on A's order either.
    const order = await confirmedOrder(agentA, userA.orgId, 'SALES', customerA);
    expect((await requestDeposit(agentB, 'SALES', order.id, { percentBp: 1000 })).status).toBe(404);

    expect((await agentB.post(`/api/v1/deposit-applications/sales/${applicationId}/void`).send({})).status).toBe(404);
    const row = await pool.query<{ status: string }>('SELECT status FROM deposit_applications WHERE id = $1', [applicationId]);
    expect(row.rows[0]?.status).toBe('POSTED');
  });

  it('15. the integrity checks all pass after the full flow (apply, void, re-apply)', async () => {
    const { deposit, final } = await paidDepositAndFinal();
    const applied = await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000);
    await agentA.post(`/api/v1/deposit-applications/sales/${applied.body.application.id as string}/void`).send({});
    expect((await applyDepositRequest(agentA, 'SALES', final, deposit, 20_000)).status).toBe(201);

    const order = await confirmedOrder(agentA, userA.orgId, 'PURCHASE', vendorA);
    const prepayment = await issuedDeposit(agentA, 'PURCHASE', order.id, { amountCents: 30_000 });
    await payDocument(agentA, userA.orgId, 'PURCHASE', vendorA, prepayment, 30_000);
    const bill = await issuedFinalDocument(agentA, 'PURCHASE', order.id);
    expect((await applyDepositRequest(agentA, 'PURCHASE', bill, prepayment, 30_000)).status).toBe(201);

    const report = await runIntegrityChecks();
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('16. voiding a payment that funded an already-applied deposit -> 409 Void the deposit applications on this invoice/bill first', async () => {
    const { deposit, final, paymentId } = await paidDepositAndFinal();
    const applied = await applyDepositRequest(agentA, 'SALES', final, deposit, 30_000);
    expect(applied.status).toBe(201);

    const refused = await agentA.post(`/api/v1/payments/${paymentId}/void`).send({});
    expect(refused.status).toBe(409);
    expect(refused.text).toContain('Void the deposit applications on this invoice first');
    // Nothing moved: the payment is still POSTED.
    const stillPosted = await agentA.get(`/api/v1/payments/${paymentId}`);
    expect(stillPosted.body.payment.status).toBe('POSTED');

    // Purchase side.
    const order = await confirmedOrder(agentA, userA.orgId, 'PURCHASE', vendorA);
    const prepayment = await issuedDeposit(agentA, 'PURCHASE', order.id, { amountCents: 30_000 });
    const billPayment = await payDocument(agentA, userA.orgId, 'PURCHASE', vendorA, prepayment, 30_000);
    const bill = await issuedFinalDocument(agentA, 'PURCHASE', order.id);
    const billApplied = await applyDepositRequest(agentA, 'PURCHASE', bill, prepayment, 30_000);
    expect(billApplied.status).toBe(201);
    const billRefused = await agentA.post(`/api/v1/payments/${billPayment}/void`).send({});
    expect(billRefused.status).toBe(409);
    expect(billRefused.text).toContain('Void the deposit applications on this bill first');

    // Once the applications are voided, the payments can be voided.
    expect(
      (await agentA.post(`/api/v1/deposit-applications/sales/${applied.body.application.id as string}/void`).send({})).status,
    ).toBe(200);
    expect((await agentA.post(`/api/v1/payments/${paymentId}/void`).send({})).status).toBe(200);
    expect(
      (await agentA.post(`/api/v1/deposit-applications/purchase/${billApplied.body.application.id as string}/void`).send({})).status,
    ).toBe(200);
    expect((await agentA.post(`/api/v1/payments/${billPayment}/void`).send({})).status).toBe(200);
  });
});
