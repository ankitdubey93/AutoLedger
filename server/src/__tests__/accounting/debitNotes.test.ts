import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting debit notes (Phase 26). Integration tier, real PostgreSQL.
 *
 * The purchase-side mirror of creditNotes.test.ts. The central claims: a
 * debit note posts DR payable / CR expense + CR input tax at its bill's own
 * rate, auto-applies to that bill up to the amount still due, never lets the
 * bill be over-settled (by payments and debits together), and is invisible
 * across tenants.
 */

const app = createApp();
const DEBIT_NOTES = '/api/v1/debit-notes';
const BILLS = '/api/v1/bills';
const PAYMENTS = '/api/v1/payments';
const VENDORS = '/api/v1/vendors';
const JOURNALS = '/api/v1/journals';
const ORGANIZATIONS = '/api/v1/organizations';
const RATES = '/api/v1/fx-rates';
const PERIODS = '/api/v1/fiscal-periods';
const ONBOARDING = '/api/v1/settings/onboarding';

const BILL_DATE = '2026-09-01';
const DUE_DATE = '2026-12-31';
const NOTE_DATE = '2026-09-05';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;
let agentB: Agent;
let vendorA: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function createVendor(agent: Agent, name: string): Promise<string> {
  const res = await agent.post(VENDORS).send({ name });
  if (res.status !== 201) throw new Error(`fixture: vendor create failed ${res.status} ${res.text}`);
  return res.body.vendor.id as string;
}

let billSequence = 0;

/** A POSTED bill (submitted and approved): one line, `unitPriceCents` × 1, on 5100 at `taxRateBp`. */
async function approvedBill(
  agent: Agent,
  orgId: string,
  vendorId: string,
  unitPriceCents: number,
  taxRateBp: number,
  extra: { currencyCode?: string; issueDate?: string } = {},
): Promise<string> {
  billSequence += 1;
  const created = await agent.post(BILLS).send({
    vendorId,
    vendorReference: `IC-${String(billSequence)}`,
    billDate: extra.issueDate ?? BILL_DATE,
    dueDate: DUE_DATE,
    currencyCode: extra.currencyCode,
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Steel bars',
        quantityMilli: 1000,
        unitPriceCents,
        expenseAccountId: await accountId(orgId, '5100'),
        taxRateBp,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: bill create failed ${created.status} ${created.text}`);
  const id = created.body.bill.id as string;
  const submitted = await agent.post(`${BILLS}/${id}/submit`).send({});
  if (submitted.status !== 200) throw new Error(`fixture: bill submit failed ${submitted.status} ${submitted.text}`);
  const approved = await agent.post(`${BILLS}/${id}/approve`).send({});
  if (approved.status !== 200) throw new Error(`fixture: bill approve failed ${approved.status} ${approved.text}`);
  return id;
}

async function notePayload(
  orgId: string,
  billId: string,
  unitPriceCents: number,
  taxRateBp: number,
  issueDate = NOTE_DATE,
) {
  return {
    billId,
    issueDate,
    reasonCode: 'RETURN',
    reason: '10 bars returned — mill-scale defects',
    vendorCreditReference: 'IC-CR-7',
    notes: null,
    lines: [
      {
        description: 'Returned steel bars',
        quantityMilli: 1000,
        unitPriceCents,
        expenseAccountId: await accountId(orgId, '5100'),
        taxRateBp,
      },
    ],
  };
}

async function draftNote(
  agent: Agent,
  orgId: string,
  billId: string,
  unitPriceCents: number,
  taxRateBp: number,
): Promise<string> {
  const res = await agent.post(DEBIT_NOTES).send(await notePayload(orgId, billId, unitPriceCents, taxRateBp));
  if (res.status !== 201) throw new Error(`fixture: debit note create failed ${res.status} ${res.text}`);
  return res.body.debitNote.id as string;
}

async function issuedNote(
  agent: Agent,
  orgId: string,
  billId: string,
  unitPriceCents: number,
  taxRateBp: number,
): Promise<string> {
  const id = await draftNote(agent, orgId, billId, unitPriceCents, taxRateBp);
  const res = await agent.post(`${DEBIT_NOTES}/${id}/issue`).send({});
  if (res.status !== 200) throw new Error(`fixture: debit note issue failed ${res.status} ${res.text}`);
  return id;
}

async function pay(
  agent: Agent,
  orgId: string,
  vendorId: string,
  billId: string,
  amountCents: number,
  extra: { currencyCode?: string; paymentDate?: string } = {},
) {
  return agent.post(PAYMENTS).send({
    direction: 'PAY',
    paymentDate: extra.paymentDate ?? NOTE_DATE,
    amountCents,
    currencyCode: extra.currencyCode,
    cashAccountId: await accountId(orgId, '1110'),
    vendorId,
    allocations: [{ invoiceId: null, billId, amountCents }],
  });
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  vendorA = await createVendor(agentA, 'Ironclad');
});

afterAll(closePool);

describe('debit notes — lifecycle and posting', () => {
  it('creates a DRAFT against an approved bill, copying vendor, currency and rate', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 1000);

    const res = await agentA.post(DEBIT_NOTES).send(await notePayload(orgA, billId, 20000, 1000));

    expect(res.status).toBe(201);
    const note = res.body.debitNote;
    expect(note.status).toBe('DRAFT');
    expect(note.debitNoteNumber).toBeNull();
    expect(note.vendorId).toBe(vendorA);
    expect(note.billId).toBe(billId);
    expect(note.billVendorReference).toBe('IC-1');
    expect(note.vendorCreditReference).toBe('IC-CR-7');
    expect(note.currencyCode).toBe('USD');
    expect(note.fxRate).toBe('1.00000000');
    expect(note.subtotalCents).toBe(20000);
    expect(note.taxCents).toBe(2000);
    expect(note.totalCents).toBe(22000);
    expect(note.allocations).toEqual([]);
  });

  it('issuing posts DR payable, CR expense and input tax, and auto-applies to the bill', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 1000);
    const noteId = await draftNote(agentA, orgA, billId, 20000, 1000);

    const res = await agentA.post(`${DEBIT_NOTES}/${noteId}/issue`).send({});

    expect(res.status).toBe(200);
    const note = res.body.debitNote;
    expect(note.status).toBe('ISSUED');
    expect(note.debitNoteNumber).toBe('DN-000001');
    expect(note.allocations).toHaveLength(1);
    expect(note.allocations[0].billId).toBe(billId);
    expect(note.allocations[0].amountCents).toBe(22000);
    expect(note.allocations[0].allocationDate).toBe(NOTE_DATE);
    expect(note.appliedCents).toBe(22000);
    expect(note.unappliedCents).toBe(0);

    const journal = await agentA.get(`${JOURNALS}/${note.journalEntryId as string}`);
    expect(journal.body.entry.sourceType).toBe('debit_note');
    const lines = journal.body.entry.lines as { accountCode: string; debitCents: number; creditCents: number }[];
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.accountCode === '2100')).toMatchObject({ debitCents: 22000, creditCents: 0 });
    expect(lines.find((l) => l.accountCode === '5100')).toMatchObject({ debitCents: 0, creditCents: 20000 });
    expect(lines.find((l) => l.accountCode === '1180')).toMatchObject({ debitCents: 0, creditCents: 2000 });

    const bill = (await agentA.get(`${BILLS}/${billId}`)).body.bill;
    expect(bill.debitedCents).toBe(22000);
    expect(bill.allocatedCents).toBe(0);
    expect(bill.amountDueCents).toBe(88000);
    expect(bill.settlementStatus).toBe('PARTIALLY_PAID');
  });

  it('a payment above the debited amount due is refused', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 1000);
    await issuedNote(agentA, orgA, billId, 20000, 1000);

    const over = await pay(agentA, orgA, vendorA, billId, 90000);
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('Allocation exceeds the amount still due on this document');

    const exact = await pay(agentA, orgA, vendorA, billId, 88000);
    expect(exact.status).toBe(201);
    const bill = (await agentA.get(`${BILLS}/${billId}`)).body.bill;
    expect(bill.amountDueCents).toBe(0);
    expect(bill.settlementStatus).toBe('PAID');
  });

  it('issuing against a fully paid bill leaves the whole debit unapplied', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 1000);
    await pay(agentA, orgA, vendorA, billId, 110000);

    const noteId = await issuedNote(agentA, orgA, billId, 20000, 1000);

    const note = (await agentA.get(`${DEBIT_NOTES}/${noteId}`)).body.debitNote;
    expect(note.allocations).toEqual([]);
    expect(note.appliedCents).toBe(0);
    expect(note.unappliedCents).toBe(22000);
    const openItems = await agentA.get(`${VENDORS}/${vendorA}/open-items?asOf=2026-09-10`);
    expect(openItems.body.outstandingCents).toBe(-22000);
  });

  it('unapplied credit applies to another open bill of the same vendor', async () => {
    const paidId = await approvedBill(agentA, orgA, vendorA, 100000, 1000);
    await pay(agentA, orgA, vendorA, paidId, 110000);
    const noteId = await issuedNote(agentA, orgA, paidId, 20000, 1000);
    const openId = await approvedBill(agentA, orgA, vendorA, 50000, 0, { issueDate: '2026-09-06' });

    const res = await agentA
      .post(`${DEBIT_NOTES}/${noteId}/allocations`)
      .send({ billId: openId, amountCents: 22000, allocationDate: '2026-09-06' });

    expect(res.status).toBe(201);
    expect(res.body.debitNote.unappliedCents).toBe(0);
    expect(res.body.debitNote.allocations).toHaveLength(1);
    const bill = (await agentA.get(`${BILLS}/${openId}`)).body.bill;
    expect(bill.debitedCents).toBe(22000);
    expect(bill.amountDueCents).toBe(28000);
  });

  it('applying more than is unapplied or more than is due is refused', async () => {
    const paidId = await approvedBill(agentA, orgA, vendorA, 100000, 1000);
    await pay(agentA, orgA, vendorA, paidId, 110000);
    const noteId = await issuedNote(agentA, orgA, paidId, 20000, 1000);
    const bigId = await approvedBill(agentA, orgA, vendorA, 50000, 0, { issueDate: '2026-09-06' });
    const smallId = await approvedBill(agentA, orgA, vendorA, 10000, 0, { issueDate: '2026-09-06' });

    const tooMuchCredit = await agentA
      .post(`${DEBIT_NOTES}/${noteId}/allocations`)
      .send({ billId: bigId, amountCents: 23000, allocationDate: '2026-09-06' });
    expect(tooMuchCredit.status).toBe(422);
    expect(tooMuchCredit.body.error).toBe('Amount exceeds the credit still available on this debit note');

    const tooMuchDue = await agentA
      .post(`${DEBIT_NOTES}/${noteId}/allocations`)
      .send({ billId: smallId, amountCents: 20000, allocationDate: '2026-09-06' });
    expect(tooMuchDue.status).toBe(422);
    expect(tooMuchDue.body.error).toBe('Amount exceeds the amount still due on this bill');
  });

  it("applying to another vendor's bill is refused", async () => {
    const paidId = await approvedBill(agentA, orgA, vendorA, 100000, 1000);
    await pay(agentA, orgA, vendorA, paidId, 110000);
    const noteId = await issuedNote(agentA, orgA, paidId, 20000, 1000);
    const otherVendor = await createVendor(agentA, 'Northgate');
    const otherBill = await approvedBill(agentA, orgA, otherVendor, 50000, 0, { issueDate: '2026-09-06' });

    const res = await agentA
      .post(`${DEBIT_NOTES}/${noteId}/allocations`)
      .send({ billId: otherBill, amountCents: 1000, allocationDate: '2026-09-06' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('That bill belongs to a different vendor');
  });

  it('cumulative debit notes cannot exceed the bill total', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 110000, 0);
    await issuedNote(agentA, orgA, billId, 100000, 0);

    const res = await agentA.post(DEBIT_NOTES).send(await notePayload(orgA, billId, 20000, 0));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Debit notes against this bill would exceed the bill total');
  });

  it('a debit note cannot be created against a draft bill', async () => {
    const created = await agentA.post(BILLS).send({
      vendorId: vendorA,
      vendorReference: 'DRAFT-1',
      billDate: BILL_DATE,
      dueDate: DUE_DATE,
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Draft',
          quantityMilli: 1000,
          unitPriceCents: 1000,
          expenseAccountId: await accountId(orgA, '5100'),
          taxRateBp: 0,
        },
      ],
    });

    const res = await agentA.post(DEBIT_NOTES).send(await notePayload(orgA, created.body.bill.id as string, 500, 0));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only an approved bill can be debited');
  });

  it('a debit note cannot be dated before its bill', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 0);

    const res = await agentA.post(DEBIT_NOTES).send(await notePayload(orgA, billId, 1000, 0, '2026-08-31'));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('A debit note cannot be dated before its bill');
  });

  it('drafts can be edited and deleted; issued notes cannot', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 0);
    const draftId = await draftNote(agentA, orgA, billId, 1000, 0);

    const patched = await agentA.patch(`${DEBIT_NOTES}/${draftId}`).send(await notePayload(orgA, billId, 2500, 0));
    expect(patched.status).toBe(200);
    expect(patched.body.debitNote.totalCents).toBe(2500);

    const deleted = await agentA.delete(`${DEBIT_NOTES}/${draftId}`);
    expect(deleted.status).toBe(204);

    const issuedId = await issuedNote(agentA, orgA, billId, 1000, 0);
    const patchIssued = await agentA.patch(`${DEBIT_NOTES}/${issuedId}`).send(await notePayload(orgA, billId, 2500, 0));
    expect(patchIssued.status).toBe(409);
    expect(patchIssued.body.error).toBe('Only a draft debit note can be edited');

    const deleteIssued = await agentA.delete(`${DEBIT_NOTES}/${issuedId}`);
    expect(deleteIssued.status).toBe(409);
    expect(deleteIssued.body.error).toBe('Only a draft debit note can be deleted');
  });

  it('voiding an issued debit note reverses it and re-opens the bill', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 1000);
    const noteId = await issuedNote(agentA, orgA, billId, 20000, 1000);

    const res = await agentA.post(`${DEBIT_NOTES}/${noteId}/void`).send({});

    expect(res.status).toBe(200);
    expect(res.body.debitNote.status).toBe('VOID');
    expect(res.body.debitNote.voidJournalEntryId).not.toBeNull();
    expect(res.body.debitNote.appliedCents).toBe(0);
    const bill = (await agentA.get(`${BILLS}/${billId}`)).body.bill;
    expect(bill.debitedCents).toBe(0);
    expect(bill.amountDueCents).toBe(110000);

    const again = await agentA.post(`${DEBIT_NOTES}/${noteId}/void`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This debit note has already been voided');
  });

  it('a bill with an issued debit note cannot be voided', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 0);
    await issuedNote(agentA, orgA, billId, 1000, 0);

    const res = await agentA.post(`${BILLS}/${billId}/void`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This bill has debit notes. Void the debit notes first.');
  });

  it('a foreign-currency debit note posts at the bill rate and is capped at the amount still due', async () => {
    const patched = await agentA.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
    expect(patched.status).toBe(200);
    await agentA.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });

    const openId = await approvedBill(agentA, orgA, vendorA, 100000, 0, { currencyCode: 'USD' });
    const noteId = await issuedNote(agentA, orgA, openId, 10000, 0);
    const note = (await agentA.get(`${DEBIT_NOTES}/${noteId}`)).body.debitNote;
    expect(note.currencyCode).toBe('USD');
    expect(note.fxRate).toBe('83.00000000');
    expect(note.baseTotalCents).toBe(830000);
    const journal = await agentA.get(`${JOURNALS}/${note.journalEntryId as string}`);
    const payable = (journal.body.entry.lines as { accountCode: string; fxRate: string; baseDebitCents: number }[])
      .find((l) => l.accountCode === '2100');
    expect(payable?.fxRate).toBe('83.00000000');
    expect(payable?.baseDebitCents).toBe(830000);

    const paidId = await approvedBill(agentA, orgA, vendorA, 100000, 0, { currencyCode: 'USD' });
    const paid = await pay(agentA, orgA, vendorA, paidId, 100000, { currencyCode: 'USD' });
    expect(paid.status).toBe(201);

    const res = await agentA.post(DEBIT_NOTES).send(await notePayload(orgA, paidId, 10000, 0));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('A foreign-currency debit note cannot exceed the amount still due on its bill');
  });

  it('issuing into a locked period rolls back completely', async () => {
    const onboarded = await agentA.post(ONBOARDING).send({
      organizationName: 'Org Alpha',
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      booksStartDate: '2026-01-01',
    });
    expect(onboarded.status).toBe(200);
    const generated = await agentA.post(`${PERIODS}/generate`).send({ containingDate: '2026-06-15' });
    const september = (generated.body.periods as { id: string; startsOn: string }[]).find((p) =>
      p.startsOn.startsWith('2026-09'),
    );
    if (september === undefined) throw new Error('fixture: no September period');

    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 0);
    const noteId = await draftNote(agentA, orgA, billId, 1000, 0);
    await agentA.post(`${PERIODS}/${september.id}/close`);
    await agentA.post(`${PERIODS}/${september.id}/lock`);

    const res = await agentA.post(`${DEBIT_NOTES}/${noteId}/issue`).send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('is locked');
    const note = (await agentA.get(`${DEBIT_NOTES}/${noteId}`)).body.debitNote;
    expect(note.status).toBe('DRAFT');
    expect(note.debitNoteNumber).toBeNull();
    const { rows: counter } = await pool.query<{ debit_note_next_number: number }>(
      'SELECT debit_note_next_number FROM ledger_invoice_settings WHERE org_id = $1',
      [orgA],
    );
    expect(counter[0]?.debit_note_next_number ?? 1).toBe(1);
    const { rows: entries } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM journal_entries WHERE org_id = $1 AND source_type = 'debit_note'`,
      [orgA],
    );
    expect(entries[0]?.count).toBe('0');
  });

  it('a VIEWER can read but not write', async () => {
    const billId = await approvedBill(agentA, orgA, vendorA, 100000, 0);
    const viewer = await createUserWithOrg({ label: 'vera', orgName: 'Vera Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const read = await viewerAgent.get(DEBIT_NOTES);
    expect(read.status).toBe(200);

    const write = await viewerAgent.post(DEBIT_NOTES).send(await notePayload(orgA, billId, 1000, 0));
    expect(write.status).toBe(403);
  });
});

describe('debit notes — cross-tenant isolation', () => {
  it("org B cannot read, debit, apply to, or list org A's documents", async () => {
    const billA = await approvedBill(agentA, orgA, vendorA, 100000, 0);
    const noteA = await issuedNote(agentA, orgA, billA, 1000, 0);

    const listed = await agentB.get(DEBIT_NOTES);
    expect(listed.status).toBe(200);
    expect(listed.body.totalCount).toBe(0);

    const read = await agentB.get(`${DEBIT_NOTES}/${noteA}`);
    expect(read.status).toBe(404);
    expect(read.body.error).toBe('Debit note not found');

    const debitAttempt = await agentB.post(DEBIT_NOTES).send(await notePayload(orgB, billA, 1000, 0));
    expect(debitAttempt.status).toBe(422);
    expect(debitAttempt.body.error).toBe('Bill not found');

    const vendorB = await createVendor(agentB, 'Bravo Supplier');
    const billB = await approvedBill(agentB, orgB, vendorB, 100000, 0);
    await pay(agentB, orgB, vendorB, billB, 100000);
    const noteB = await issuedNote(agentB, orgB, billB, 1000, 0);
    const apply = await agentB
      .post(`${DEBIT_NOTES}/${noteB}/allocations`)
      .send({ billId: billA, amountCents: 1000, allocationDate: NOTE_DATE });
    expect(apply.status).toBe(422);
    expect(apply.body.error).toBe('Bill not found');

    const voidAttempt = await agentB.post(`${DEBIT_NOTES}/${noteA}/void`).send({});
    expect(voidAttempt.status).toBe(404);
  });
});
