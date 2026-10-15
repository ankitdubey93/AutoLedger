import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { runIntegrityChecks } from '../../db/integrity.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer, type Agent } from '../helpers/accountingFixtures.js';
import {
  confirmedOrder,
  createVendor,
  issuedDeposit,
  journalLines,
  payDocument,
} from '../helpers/depositFixtures.js';

/**
 * Phase 43c — open debit/credit notes and prepayments/deposits applied in the
 * SAME transaction as a bill's approval or an invoice's issue. Integration
 * tier, real PostgreSQL. Amounts are integer cents.
 *
 * The central claims: available-credits is computed against the document in
 * hand; a rejected credit rolls the approval back with it; applying a note
 * needs its own permission; none of it crosses tenants; and the party ledger,
 * the open items and the integrity verifier all still agree afterwards.
 */

const app = createApp();
const BILLS = '/api/v1/bills';
const INVOICES = '/api/v1/invoices';
const DEBIT_NOTES = '/api/v1/debit-notes';
const CREDIT_NOTES = '/api/v1/credit-notes';
const PAYMENTS = '/api/v1/payments';
const VENDORS = '/api/v1/vendors';
const CUSTOMERS = '/api/v1/customers';

const BILL_DATE = '2026-09-01';
const DUE_DATE = '2026-12-31';
const NOTE_DATE = '2026-09-05';

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;
let vendorA: string;
let customerA: string;
let sequence = 0;

/** A bill in DRAFT, or AWAITING_APPROVAL when `submit`, or POSTED when `approve`. */
async function bill(
  agent: Agent,
  orgId: string,
  vendorId: string,
  cents: number,
  stage: 'draft' | 'submitted' | 'approved',
): Promise<string> {
  sequence += 1;
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: `AC-${String(sequence)}`,
    billDate: BILL_DATE,
    dueDate: DUE_DATE,
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Steel bars',
        quantityMilli: 1000,
        unitPriceCents: cents,
        expenseAccountId: await accountId(orgId, '5100'),
        taxRateBp: 0,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: bill create ${created.status} ${created.text}`);
  const id = created.body.bill.id as string;
  if (stage === 'draft') return id;
  const submitted = await agent.post(`${BILLS}/${id}/submit`).send({});
  if (submitted.status !== 200) throw new Error(`fixture: bill submit ${submitted.status} ${submitted.text}`);
  if (stage === 'submitted') return id;
  const approved = await agent.post(`${BILLS}/${id}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: bill approve ${approved.status} ${approved.text}`);
  return id;
}

/** A fully paid 10000 bill plus an ISSUED debit note of `noteCents` against it: the note is wholly unapplied. */
async function unappliedDebitNote(agent: Agent, orgId: string, vendorId: string, noteCents: number): Promise<string> {
  const billId = await bill(agent, orgId, vendorId, 10000, 'approved');
  const paid = await agent.post(PAYMENTS).send({
    direction: 'PAY',
    paymentDate: NOTE_DATE,
    amountCents: 10000,
    cashAccountId: await accountId(orgId, '1110'),
    vendorId,
    allocations: [{ invoiceId: null, billId, amountCents: 10000 }],
  });
  if (paid.status !== 201) throw new Error(`fixture: payment ${paid.status} ${paid.text}`);
  const created = await agent.post(DEBIT_NOTES).send({
    billId,
    issueDate: NOTE_DATE,
    reasonCode: 'RETURN',
    reason: 'returned',
    vendorCreditReference: null,
    notes: null,
    lines: [
      {
        description: 'Returned bars',
        quantityMilli: 1000,
        unitPriceCents: noteCents,
        expenseAccountId: await accountId(orgId, '5100'),
        taxRateBp: 0,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: debit note create ${created.status} ${created.text}`);
  const id = created.body.debitNote.id as string;
  const issued = await agent.post(`${DEBIT_NOTES}/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: debit note issue ${issued.status} ${issued.text}`);
  return id;
}

async function getBill(id: string) {
  const res = await agentA.get(`${BILLS}/${id}`);
  expect(res.status).toBe(200);
  return res.body.bill as {
    status: string;
    amountDueCents: number;
    depositApplications: { journalEntryId: string; amountCents: number }[];
  };
}

async function getDebitNote(id: string) {
  const res = await agentA.get(`${DEBIT_NOTES}/${id}`);
  expect(res.status).toBe(200);
  return res.body.debitNote as { unappliedCents: number; appliedCents: number };
}

async function applyCreditsOnPostedBill(agent: Agent, billId: string, applyCredits: unknown[]) {
  return agent.post(`${BILLS}/${billId}/approve`).send({ applyCredits });
}

async function expectIntegrity() {
  const report = await runIntegrityChecks();
  expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  expect(report.passed).toBe(true);
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  vendorA = await createVendor(agentA, 'Ironclad');
  customerA = await createCustomer(agentA, 'Acme Fitouts', 'buyer@acme.test');
});

afterAll(closePool);

describe('applying open credit when a bill is approved or an invoice is issued', () => {
  it('1. available-credits lists the vendor’s unapplied debit note for another bill', async () => {
    const dn = await unappliedDebitNote(agentA, userA.orgId, vendorA, 3000);
    expect((await getDebitNote(dn)).unappliedCents).toBe(3000);
    const b2 = await bill(agentA, userA.orgId, vendorA, 15000, 'submitted');

    const res = await agentA.get(`${BILLS}/${b2}/available-credits`);

    expect(res.status).toBe(200);
    expect(res.body.credits).toEqual([
      expect.objectContaining({ kind: 'NOTE', id: dn, availableCents: 3000, currencyCode: 'USD' }),
    ]);
  });

  it('2. approving with the note applies it atomically: amount due 12000, note fully applied, ledger = open items', async () => {
    const dn = await unappliedDebitNote(agentA, userA.orgId, vendorA, 3000);
    const b2 = await bill(agentA, userA.orgId, vendorA, 15000, 'submitted');

    const res = await applyCreditsOnPostedBill(agentA, b2, [{ kind: 'NOTE', id: dn, amountCents: 3000 }]);

    expect(res.status).toBe(200);
    expect(res.body.bill.status).toBe('POSTED');
    expect((await getBill(b2)).amountDueCents).toBe(12000);
    expect((await getDebitNote(dn)).unappliedCents).toBe(0);

    const ledger = await agentA.get(`${VENDORS}/${vendorA}/ledger?to=2026-12-31`);
    const open = await agentA.get(`${VENDORS}/${vendorA}/open-items?asOf=2026-12-31`);
    expect(ledger.body.closingBalanceCents).toBe(open.body.outstandingCents);
    expect(open.body.outstandingCents).toBe(12000);
  });

  it('3. over-application is refused and rolls the approval back', async () => {
    const dn = await unappliedDebitNote(agentA, userA.orgId, vendorA, 3000);

    // More than the note has left: the note's own check speaks first.
    const big = await bill(agentA, userA.orgId, vendorA, 15000, 'submitted');
    const overNote = await applyCreditsOnPostedBill(agentA, big, [{ kind: 'NOTE', id: dn, amountCents: 20000 }]);
    expect(overNote.status).toBe(422);
    expect(overNote.text).toContain('Amount exceeds the credit still available on this debit note');

    // Within the note but more than this bill still owes.
    const small = await bill(agentA, userA.orgId, vendorA, 2000, 'submitted');
    const overDue = await applyCreditsOnPostedBill(agentA, small, [{ kind: 'NOTE', id: dn, amountCents: 3000 }]);
    expect(overDue.status).toBe(422);
    expect(overDue.text).toContain('Amount exceeds the amount still due on this bill');

    expect((await getBill(big)).status).toBe('AWAITING_APPROVAL');
    expect((await getBill(small)).status).toBe('AWAITING_APPROVAL');
    expect((await getDebitNote(dn)).unappliedCents).toBe(3000);
  });

  it('4. another vendor’s note is refused and the approval is rolled back', async () => {
    const vendorW = await createVendor(agentA, 'Weldworks');
    const foreignNote = await unappliedDebitNote(agentA, userA.orgId, vendorW, 3000);
    const b2 = await bill(agentA, userA.orgId, vendorA, 15000, 'submitted');

    const res = await applyCreditsOnPostedBill(agentA, b2, [{ kind: 'NOTE', id: foreignNote, amountCents: 1000 }]);

    expect(res.status).toBe(422);
    expect(res.text).toContain('That bill belongs to a different vendor');
    expect((await getBill(b2)).status).toBe('AWAITING_APPROVAL');
    expect((await getDebitNote(foreignNote)).unappliedCents).toBe(3000);
  });

  it('5. another organization’s note id is not found (404) and the approval is rolled back', async () => {
    const vendorB = await createVendor(agentB, 'Bravo Supply');
    const orgBNote = await unappliedDebitNote(agentB, userB.orgId, vendorB, 3000);
    const b2 = await bill(agentA, userA.orgId, vendorA, 15000, 'submitted');

    const res = await applyCreditsOnPostedBill(agentA, b2, [{ kind: 'NOTE', id: orgBNote, amountCents: 1000 }]);

    // The core (lockNote) is org-scoped, so a foreign id is simply not there.
    expect(res.status).toBe(404);
    expect(res.text).toContain('Debit note not found');
    expect((await getBill(b2)).status).toBe('AWAITING_APPROVAL');
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM debit_note_allocations WHERE org_id = $1',
      [userB.orgId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('6. a paid prepayment is offered and applied on approval: DR 2100 / CR 1150, amount due reduced by 5000', async () => {
    const order = await confirmedOrder(agentA, userA.orgId, 'PURCHASE', vendorA, 100_000);
    const prepayment = await issuedDeposit(agentA, 'PURCHASE', order.id, { amountCents: 5_000 });
    await payDocument(agentA, userA.orgId, 'PURCHASE', vendorA, prepayment, 5_000);
    const converted = await agentA.post(`/api/v1/purchase-orders/${order.id}/convert`).send({});
    expect(converted.status).toBe(201);
    const finalBill = converted.body.document.id as string;
    expect((await agentA.post(`${BILLS}/${finalBill}/submit`).send({})).status).toBe(200);

    const offered = await agentA.get(`${BILLS}/${finalBill}/available-credits`);
    expect(offered.body.credits).toEqual([
      expect.objectContaining({ kind: 'DEPOSIT', id: prepayment, availableCents: 5000 }),
    ]);

    const res = await applyCreditsOnPostedBill(agentA, finalBill, [
      { kind: 'DEPOSIT', id: prepayment, amountCents: 5000 },
    ]);

    expect(res.status).toBe(200);
    const after = await getBill(finalBill);
    expect(after.status).toBe('POSTED');
    expect(after.amountDueCents).toBe(95_000);
    const application = after.depositApplications[0];
    expect(application?.amountCents).toBe(5000);
    expect(await journalLines(userA.orgId, application?.journalEntryId as string)).toEqual([
      { code: '1150', debit: 0, credit: 5000 },
      { code: '2100', debit: 5000, credit: 0 },
    ]);
    // Fully used: nothing left to offer another document.
    const again = await agentA.get(`${BILLS}/${finalBill}/available-credits`);
    expect(again.body.credits).toEqual([]);
  });

  it('7. an unapplied customer credit note is applied when the invoice is issued', async () => {
    const revenue = await accountId(userA.orgId, '4100');
    async function draftInvoice(cents: number): Promise<string> {
      const created = await agentA.post(INVOICES).send({
        customerId: customerA,
        issueDate: '2026-09-01',
        dueDate: DUE_DATE,
        notes: null,
        paymentTerms: null,
        lines: [{ description: 'Work', quantityMilli: 1000, unitPriceCents: cents, revenueAccountId: revenue, taxRateBp: 0 }],
      });
      expect(created.status).toBe(201);
      return created.body.invoice.id as string;
    }
    const first = await draftInvoice(10000);
    expect((await agentA.post(`${INVOICES}/${first}/issue`).send({})).status).toBe(200);
    const paid = await agentA.post(PAYMENTS).send({
      direction: 'RECEIVE',
      paymentDate: NOTE_DATE,
      amountCents: 10000,
      cashAccountId: await accountId(userA.orgId, '1110'),
      customerId: customerA,
      allocations: [{ invoiceId: first, billId: null, amountCents: 10000 }],
    });
    expect(paid.status).toBe(201);
    const noteDraft = await agentA.post(CREDIT_NOTES).send({
      invoiceId: first,
      issueDate: NOTE_DATE,
      reasonCode: 'RETURN',
      reason: 'returned',
      notes: null,
      lines: [
        {
          description: 'Returned kits',
          quantityMilli: 1000,
          unitPriceCents: 2000,
          revenueAccountId: await accountId(userA.orgId, '4800'),
          taxRateBp: 0,
        },
      ],
    });
    expect(noteDraft.status).toBe(201);
    const creditNote = noteDraft.body.creditNote.id as string;
    expect((await agentA.post(`${CREDIT_NOTES}/${creditNote}/issue`).send({})).status).toBe(200);

    const second = await draftInvoice(8000);
    const offered = await agentA.get(`${INVOICES}/${second}/available-credits`);
    expect(offered.body.credits).toEqual([
      expect.objectContaining({ kind: 'NOTE', id: creditNote, availableCents: 2000 }),
    ]);

    const issued = await agentA
      .post(`${INVOICES}/${second}/issue`)
      .send({ applyCredits: [{ kind: 'NOTE', id: creditNote, amountCents: 2000 }] });

    expect(issued.status).toBe(200);
    expect(issued.body.invoice.status).toBe('ISSUED');
    expect(issued.body.invoice.amountDueCents).toBe(6000);
    const ledger = await agentA.get(`${CUSTOMERS}/${customerA}/ledger?to=2026-12-31`);
    const open = await agentA.get(`${CUSTOMERS}/${customerA}/open-items?asOf=2026-12-31`);
    expect(ledger.body.closingBalanceCents).toBe(open.body.outstandingCents);
  });

  it('8. applying a note needs debit_notes.issue on top of bills.approve; an empty list does not', async () => {
    const dn = await unappliedDebitNote(agentA, userA.orgId, vendorA, 3000);
    const b2 = await bill(agentA, userA.orgId, vendorA, 15000, 'submitted');

    const role = await agentA
      .post('/api/v1/organizations/roles')
      .send({ name: 'Approver', permissions: ['bills.approve'] });
    expect(role.status).toBe(201);
    const approver = await createUserWithOrg({ label: 'approver' });
    await addMember(userA.orgId, approver.id, 'VIEWER');
    await agentA
      .patch(`/api/v1/organizations/members/${approver.id}`)
      .send({ customRoleId: role.body.role.id as string })
      .expect(200);
    const approverAgent = await loginAgent(app, approver);
    await approverAgent.post('/api/v1/auth/switch-org').send({ orgId: userA.orgId }).expect(200);

    const denied = await applyCreditsOnPostedBill(approverAgent, b2, [{ kind: 'NOTE', id: dn, amountCents: 3000 }]);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('Applying a debit note needs the "Issue and apply debit notes" permission.');
    expect((await getBill(b2)).status).toBe('AWAITING_APPROVAL');

    const plain = await applyCreditsOnPostedBill(approverAgent, b2, []);
    expect(plain.status).toBe(200);
    expect(plain.body.bill.status).toBe('POSTED');
  });

  it('9. listing the same credit twice is a 400', async () => {
    const dn = await unappliedDebitNote(agentA, userA.orgId, vendorA, 3000);
    const b2 = await bill(agentA, userA.orgId, vendorA, 15000, 'submitted');

    const res = await applyCreditsOnPostedBill(agentA, b2, [
      { kind: 'NOTE', id: dn, amountCents: 1000 },
      { kind: 'NOTE', id: dn, amountCents: 1000 },
    ]);

    expect(res.status).toBe(400);
    expect(res.text).toContain('Each credit can be listed once');
    expect((await getBill(b2)).status).toBe('AWAITING_APPROVAL');
  });

  it('10. the integrity verifier passes after a note, a prepayment and a credit note have been applied on posting', async () => {
    const dn = await unappliedDebitNote(agentA, userA.orgId, vendorA, 3000);
    const b2 = await bill(agentA, userA.orgId, vendorA, 15000, 'submitted');
    expect((await applyCreditsOnPostedBill(agentA, b2, [{ kind: 'NOTE', id: dn, amountCents: 3000 }])).status).toBe(200);

    const order = await confirmedOrder(agentA, userA.orgId, 'PURCHASE', vendorA, 100_000);
    const prepayment = await issuedDeposit(agentA, 'PURCHASE', order.id, { amountCents: 5_000 });
    await payDocument(agentA, userA.orgId, 'PURCHASE', vendorA, prepayment, 5_000);
    const converted = await agentA.post(`/api/v1/purchase-orders/${order.id}/convert`).send({});
    const finalBill = converted.body.document.id as string;
    await agentA.post(`${BILLS}/${finalBill}/submit`).send({});
    expect(
      (await applyCreditsOnPostedBill(agentA, finalBill, [{ kind: 'DEPOSIT', id: prepayment, amountCents: 5000 }])).status,
    ).toBe(200);

    await expectIntegrity();
  });
});
