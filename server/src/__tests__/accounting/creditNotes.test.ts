import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * Accounting credit notes (Phase 26). Integration tier, real PostgreSQL.
 *
 * The central claims: a credit note posts DR revenue + DR tax / CR receivable
 * at its invoice's own rate, auto-applies to that invoice up to the amount
 * still due, never lets the invoice be over-settled (by payments and credits
 * together), and is invisible across tenants.
 */

const app = createApp();
const CREDIT_NOTES = '/api/v1/credit-notes';
const INVOICES = '/api/v1/invoices';
const PAYMENTS = '/api/v1/payments';
const CUSTOMERS = '/api/v1/customers';
const JOURNALS = '/api/v1/journals';
const ORGANIZATIONS = '/api/v1/organizations';
const RATES = '/api/v1/fx-rates';
const PERIODS = '/api/v1/fiscal-periods';
const ONBOARDING = '/api/v1/settings/onboarding';

const INVOICE_DATE = '2026-09-01';
const DUE_DATE = '2026-12-31';
const NOTE_DATE = '2026-09-05';

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;
let agentB: Agent;
let customerA: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

async function createCustomer(agent: Agent, name: string): Promise<string> {
  const res = await agent.post(CUSTOMERS).send({ name });
  if (res.status !== 201) throw new Error(`fixture: customer create failed ${res.status} ${res.text}`);
  return res.body.customer.id as string;
}

/** An ISSUED invoice: one line, `unitPriceCents` × 1, on 4100 at `taxRateBp`. */
async function issuedInvoice(
  agent: Agent,
  orgId: string,
  customerId: string,
  unitPriceCents: number,
  taxRateBp: number,
  extra: { currencyCode?: string; issueDate?: string } = {},
): Promise<string> {
  const created = await agent.post(INVOICES).send({
    customerId,
    issueDate: extra.issueDate ?? INVOICE_DATE,
    dueDate: DUE_DATE,
    currencyCode: extra.currencyCode,
    notes: null,
    paymentTerms: null,
    lines: [
      {
        description: 'Bracket kits',
        quantityMilli: 1000,
        unitPriceCents,
        revenueAccountId: await accountId(orgId, '4100'),
        taxRateBp,
      },
    ],
  });
  if (created.status !== 201) throw new Error(`fixture: invoice create failed ${created.status} ${created.text}`);
  const id = created.body.invoice.id as string;
  const issued = await agent.post(`${INVOICES}/${id}/issue`).send({});
  if (issued.status !== 200) throw new Error(`fixture: invoice issue failed ${issued.status} ${issued.text}`);
  return id;
}

async function notePayload(
  orgId: string,
  invoiceId: string,
  unitPriceCents: number,
  taxRateBp: number,
  issueDate = NOTE_DATE,
) {
  return {
    invoiceId,
    issueDate,
    reasonCode: 'RETURN',
    reason: '3 kits returned — weld porosity',
    notes: null,
    lines: [
      {
        description: 'Returned bracket kits',
        quantityMilli: 1000,
        unitPriceCents,
        revenueAccountId: await accountId(orgId, '4800'),
        taxRateBp,
      },
    ],
  };
}

async function draftNote(
  agent: Agent,
  orgId: string,
  invoiceId: string,
  unitPriceCents: number,
  taxRateBp: number,
): Promise<string> {
  const res = await agent.post(CREDIT_NOTES).send(await notePayload(orgId, invoiceId, unitPriceCents, taxRateBp));
  if (res.status !== 201) throw new Error(`fixture: credit note create failed ${res.status} ${res.text}`);
  return res.body.creditNote.id as string;
}

async function issuedNote(
  agent: Agent,
  orgId: string,
  invoiceId: string,
  unitPriceCents: number,
  taxRateBp: number,
): Promise<string> {
  const id = await draftNote(agent, orgId, invoiceId, unitPriceCents, taxRateBp);
  const res = await agent.post(`${CREDIT_NOTES}/${id}/issue`).send({});
  if (res.status !== 200) throw new Error(`fixture: credit note issue failed ${res.status} ${res.text}`);
  return id;
}

async function receive(
  agent: Agent,
  orgId: string,
  customerId: string,
  invoiceId: string,
  amountCents: number,
  extra: { currencyCode?: string; paymentDate?: string } = {},
) {
  return agent.post(PAYMENTS).send({
    direction: 'RECEIVE',
    paymentDate: extra.paymentDate ?? NOTE_DATE,
    amountCents,
    currencyCode: extra.currencyCode,
    cashAccountId: await accountId(orgId, '1110'),
    customerId,
    allocations: [{ invoiceId, billId: null, amountCents }],
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
  customerA = await createCustomer(agentA, 'Acme');
});

afterAll(closePool);

describe('credit notes — lifecycle and posting', () => {
  it('creates a DRAFT against an issued invoice, copying customer, currency and rate', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 1000);

    const res = await agentA.post(CREDIT_NOTES).send(await notePayload(orgA, invoiceId, 20000, 1000));

    expect(res.status).toBe(201);
    const note = res.body.creditNote;
    expect(note.status).toBe('DRAFT');
    expect(note.creditNoteNumber).toBeNull();
    expect(note.customerId).toBe(customerA);
    expect(note.invoiceId).toBe(invoiceId);
    expect(note.currencyCode).toBe('USD');
    expect(note.fxRate).toBe('1.00000000');
    expect(note.subtotalCents).toBe(20000);
    expect(note.taxCents).toBe(2000);
    expect(note.totalCents).toBe(22000);
    expect(note.allocations).toEqual([]);
  });

  it('issuing posts DR revenue and tax, CR receivable, and auto-applies to the invoice', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 1000);
    const noteId = await draftNote(agentA, orgA, invoiceId, 20000, 1000);

    const res = await agentA.post(`${CREDIT_NOTES}/${noteId}/issue`).send({});

    expect(res.status).toBe(200);
    const note = res.body.creditNote;
    expect(note.status).toBe('ISSUED');
    expect(note.creditNoteNumber).toBe('CN-000001');
    expect(note.allocations).toHaveLength(1);
    expect(note.allocations[0].invoiceId).toBe(invoiceId);
    expect(note.allocations[0].amountCents).toBe(22000);
    expect(note.allocations[0].allocationDate).toBe(NOTE_DATE);
    expect(note.appliedCents).toBe(22000);
    expect(note.unappliedCents).toBe(0);

    const journal = await agentA.get(`${JOURNALS}/${note.journalEntryId as string}`);
    expect(journal.body.entry.sourceType).toBe('credit_note');
    const lines = journal.body.entry.lines as { accountCode: string; debitCents: number; creditCents: number }[];
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.accountCode === '4800')).toMatchObject({ debitCents: 20000, creditCents: 0 });
    expect(lines.find((l) => l.accountCode === '2140')).toMatchObject({ debitCents: 2000, creditCents: 0 });
    expect(lines.find((l) => l.accountCode === '1120')).toMatchObject({ debitCents: 0, creditCents: 22000 });

    const invoice = (await agentA.get(`${INVOICES}/${invoiceId}`)).body.invoice;
    expect(invoice.creditedCents).toBe(22000);
    expect(invoice.allocatedCents).toBe(0);
    expect(invoice.amountDueCents).toBe(88000);
    expect(invoice.settlementStatus).toBe('PARTIALLY_PAID');
  });

  it('a payment above the credited amount due is refused', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 1000);
    await issuedNote(agentA, orgA, invoiceId, 20000, 1000);

    const over = await receive(agentA, orgA, customerA, invoiceId, 90000);
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('Allocation exceeds the amount still due on this document');

    const exact = await receive(agentA, orgA, customerA, invoiceId, 88000);
    expect(exact.status).toBe(201);
    const invoice = (await agentA.get(`${INVOICES}/${invoiceId}`)).body.invoice;
    expect(invoice.amountDueCents).toBe(0);
    expect(invoice.settlementStatus).toBe('PAID');
  });

  it('issuing against a fully paid invoice leaves the whole credit unapplied', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 1000);
    await receive(agentA, orgA, customerA, invoiceId, 110000);

    const noteId = await issuedNote(agentA, orgA, invoiceId, 20000, 1000);

    const note = (await agentA.get(`${CREDIT_NOTES}/${noteId}`)).body.creditNote;
    expect(note.allocations).toEqual([]);
    expect(note.appliedCents).toBe(0);
    expect(note.unappliedCents).toBe(22000);
    const openItems = await agentA.get(`${CUSTOMERS}/${customerA}/open-items?asOf=2026-09-10`);
    expect(openItems.body.outstandingCents).toBe(-22000);
  });

  it('unapplied credit applies to another open invoice of the same customer', async () => {
    const paidId = await issuedInvoice(agentA, orgA, customerA, 100000, 1000);
    await receive(agentA, orgA, customerA, paidId, 110000);
    const noteId = await issuedNote(agentA, orgA, paidId, 20000, 1000);
    const openId = await issuedInvoice(agentA, orgA, customerA, 50000, 0, { issueDate: '2026-09-06' });

    const res = await agentA
      .post(`${CREDIT_NOTES}/${noteId}/allocations`)
      .send({ invoiceId: openId, amountCents: 22000, allocationDate: '2026-09-06' });

    expect(res.status).toBe(201);
    expect(res.body.creditNote.unappliedCents).toBe(0);
    expect(res.body.creditNote.allocations).toHaveLength(1);
    const invoice = (await agentA.get(`${INVOICES}/${openId}`)).body.invoice;
    expect(invoice.creditedCents).toBe(22000);
    expect(invoice.amountDueCents).toBe(28000);
  });

  it('applying more than is unapplied or more than is due is refused', async () => {
    const paidId = await issuedInvoice(agentA, orgA, customerA, 100000, 1000);
    await receive(agentA, orgA, customerA, paidId, 110000);
    const noteId = await issuedNote(agentA, orgA, paidId, 20000, 1000);
    const bigId = await issuedInvoice(agentA, orgA, customerA, 50000, 0, { issueDate: '2026-09-06' });
    const smallId = await issuedInvoice(agentA, orgA, customerA, 10000, 0, { issueDate: '2026-09-06' });

    const tooMuchCredit = await agentA
      .post(`${CREDIT_NOTES}/${noteId}/allocations`)
      .send({ invoiceId: bigId, amountCents: 23000, allocationDate: '2026-09-06' });
    expect(tooMuchCredit.status).toBe(422);
    expect(tooMuchCredit.body.error).toBe('Amount exceeds the credit still available on this credit note');

    const tooMuchDue = await agentA
      .post(`${CREDIT_NOTES}/${noteId}/allocations`)
      .send({ invoiceId: smallId, amountCents: 20000, allocationDate: '2026-09-06' });
    expect(tooMuchDue.status).toBe(422);
    expect(tooMuchDue.body.error).toBe('Amount exceeds the amount still due on this invoice');
  });

  it("applying to another customer's invoice is refused", async () => {
    const paidId = await issuedInvoice(agentA, orgA, customerA, 100000, 1000);
    await receive(agentA, orgA, customerA, paidId, 110000);
    const noteId = await issuedNote(agentA, orgA, paidId, 20000, 1000);
    const otherCustomer = await createCustomer(agentA, 'Globex');
    const otherInvoice = await issuedInvoice(agentA, orgA, otherCustomer, 50000, 0, { issueDate: '2026-09-06' });

    const res = await agentA
      .post(`${CREDIT_NOTES}/${noteId}/allocations`)
      .send({ invoiceId: otherInvoice, amountCents: 1000, allocationDate: '2026-09-06' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('That invoice belongs to a different customer');
  });

  it('cumulative credit notes cannot exceed the invoice total', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 110000, 0);
    await issuedNote(agentA, orgA, invoiceId, 100000, 0);

    const res = await agentA.post(CREDIT_NOTES).send(await notePayload(orgA, invoiceId, 20000, 0));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Credit notes against this invoice would exceed the invoice total');
  });

  it('a credit note cannot be created against a draft invoice', async () => {
    const created = await agentA.post(INVOICES).send({
      customerId: customerA,
      issueDate: INVOICE_DATE,
      dueDate: DUE_DATE,
      notes: null,
      paymentTerms: null,
      lines: [
        {
          description: 'Draft',
          quantityMilli: 1000,
          unitPriceCents: 1000,
          revenueAccountId: await accountId(orgA, '4100'),
          taxRateBp: 0,
        },
      ],
    });

    const res = await agentA.post(CREDIT_NOTES).send(await notePayload(orgA, created.body.invoice.id as string, 500, 0));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only an issued invoice can be credited');
  });

  it('a credit note cannot be dated before its invoice', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 0);

    const res = await agentA.post(CREDIT_NOTES).send(await notePayload(orgA, invoiceId, 1000, 0, '2026-08-31'));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('A credit note cannot be dated before its invoice');
  });

  it('drafts can be edited and deleted; issued notes cannot', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 0);
    const draftId = await draftNote(agentA, orgA, invoiceId, 1000, 0);

    const patched = await agentA.patch(`${CREDIT_NOTES}/${draftId}`).send(await notePayload(orgA, invoiceId, 2500, 0));
    expect(patched.status).toBe(200);
    expect(patched.body.creditNote.totalCents).toBe(2500);

    const deleted = await agentA.delete(`${CREDIT_NOTES}/${draftId}`);
    expect(deleted.status).toBe(204);

    const issuedId = await issuedNote(agentA, orgA, invoiceId, 1000, 0);
    const patchIssued = await agentA.patch(`${CREDIT_NOTES}/${issuedId}`).send(await notePayload(orgA, invoiceId, 2500, 0));
    expect(patchIssued.status).toBe(409);
    expect(patchIssued.body.error).toBe('Only a draft credit note can be edited');

    const deleteIssued = await agentA.delete(`${CREDIT_NOTES}/${issuedId}`);
    expect(deleteIssued.status).toBe(409);
    expect(deleteIssued.body.error).toBe('Only a draft credit note can be deleted');
  });

  it('voiding an issued credit note reverses it and re-opens the invoice', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 1000);
    const noteId = await issuedNote(agentA, orgA, invoiceId, 20000, 1000);

    const res = await agentA.post(`${CREDIT_NOTES}/${noteId}/void`).send({});

    expect(res.status).toBe(200);
    expect(res.body.creditNote.status).toBe('VOID');
    expect(res.body.creditNote.voidJournalEntryId).not.toBeNull();
    expect(res.body.creditNote.appliedCents).toBe(0);
    const invoice = (await agentA.get(`${INVOICES}/${invoiceId}`)).body.invoice;
    expect(invoice.creditedCents).toBe(0);
    expect(invoice.amountDueCents).toBe(110000);

    const again = await agentA.post(`${CREDIT_NOTES}/${noteId}/void`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This credit note has already been voided');
  });

  it('an invoice with an issued credit note cannot be voided', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 0);
    await issuedNote(agentA, orgA, invoiceId, 1000, 0);

    const res = await agentA.post(`${INVOICES}/${invoiceId}/void`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This invoice has credit notes. Void the credit notes first.');
  });

  it('a foreign-currency credit note posts at the invoice rate and is capped at the amount still due', async () => {
    const patched = await agentA.patch(ORGANIZATIONS).send({ baseCurrency: 'INR' });
    expect(patched.status).toBe(200);
    await agentA.post(RATES).send({ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' });

    const openId = await issuedInvoice(agentA, orgA, customerA, 100000, 0, { currencyCode: 'USD' });
    const noteId = await issuedNote(agentA, orgA, openId, 10000, 0);
    const note = (await agentA.get(`${CREDIT_NOTES}/${noteId}`)).body.creditNote;
    expect(note.currencyCode).toBe('USD');
    expect(note.fxRate).toBe('83.00000000');
    expect(note.baseTotalCents).toBe(830000);
    const journal = await agentA.get(`${JOURNALS}/${note.journalEntryId as string}`);
    const receivable = (journal.body.entry.lines as { accountCode: string; fxRate: string; baseCreditCents: number }[])
      .find((l) => l.accountCode === '1120');
    expect(receivable?.fxRate).toBe('83.00000000');
    expect(receivable?.baseCreditCents).toBe(830000);

    const paidId = await issuedInvoice(agentA, orgA, customerA, 100000, 0, { currencyCode: 'USD' });
    const paid = await receive(agentA, orgA, customerA, paidId, 100000, { currencyCode: 'USD' });
    expect(paid.status).toBe(201);

    const res = await agentA.post(CREDIT_NOTES).send(await notePayload(orgA, paidId, 10000, 0));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('A foreign-currency credit note cannot exceed the amount still due on its invoice');
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

    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 0);
    const noteId = await draftNote(agentA, orgA, invoiceId, 1000, 0);
    await agentA.post(`${PERIODS}/${september.id}/close`);
    await agentA.post(`${PERIODS}/${september.id}/lock`);

    const res = await agentA.post(`${CREDIT_NOTES}/${noteId}/issue`).send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('is locked');
    const note = (await agentA.get(`${CREDIT_NOTES}/${noteId}`)).body.creditNote;
    expect(note.status).toBe('DRAFT');
    expect(note.creditNoteNumber).toBeNull();
    const { rows: counter } = await pool.query<{ credit_note_next_number: number }>(
      'SELECT credit_note_next_number FROM ledger_invoice_settings WHERE org_id = $1',
      [orgA],
    );
    expect(counter[0]?.credit_note_next_number ?? 1).toBe(1);
    const { rows: entries } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM journal_entries WHERE org_id = $1 AND source_type = 'credit_note'`,
      [orgA],
    );
    expect(entries[0]?.count).toBe('0');
  });

  it('a VIEWER can read but not write', async () => {
    const invoiceId = await issuedInvoice(agentA, orgA, customerA, 100000, 0);
    const viewer = await createUserWithOrg({ label: 'vera', orgName: 'Vera Solo' });
    await addMember(orgA, viewer.id, 'VIEWER');
    const viewerAgent = await loginAgent(app, viewer);
    await viewerAgent.post('/api/v1/auth/switch-org').send({ orgId: orgA });

    const read = await viewerAgent.get(CREDIT_NOTES);
    expect(read.status).toBe(200);

    const write = await viewerAgent.post(CREDIT_NOTES).send(await notePayload(orgA, invoiceId, 1000, 0));
    expect(write.status).toBe(403);
  });
});

describe('credit notes — cross-tenant isolation', () => {
  it("org B cannot read, credit, apply to, or list org A's documents", async () => {
    const invoiceA = await issuedInvoice(agentA, orgA, customerA, 100000, 0);
    const noteA = await issuedNote(agentA, orgA, invoiceA, 1000, 0);

    const listed = await agentB.get(CREDIT_NOTES);
    expect(listed.status).toBe(200);
    expect(listed.body.totalCount).toBe(0);

    const read = await agentB.get(`${CREDIT_NOTES}/${noteA}`);
    expect(read.status).toBe(404);
    expect(read.body.error).toBe('Credit note not found');

    const credit = await agentB.post(CREDIT_NOTES).send(await notePayload(orgB, invoiceA, 1000, 0));
    expect(credit.status).toBe(422);
    expect(credit.body.error).toBe('Invoice not found');

    const customerB = await createCustomer(agentB, 'Bravo Buyer');
    const invoiceB = await issuedInvoice(agentB, orgB, customerB, 100000, 0);
    await receive(agentB, orgB, customerB, invoiceB, 100000);
    const noteB = await issuedNote(agentB, orgB, invoiceB, 1000, 0);
    const apply = await agentB
      .post(`${CREDIT_NOTES}/${noteB}/allocations`)
      .send({ invoiceId: invoiceA, amountCents: 1000, allocationDate: NOTE_DATE });
    expect(apply.status).toBe(422);
    expect(apply.body.error).toBe('Invoice not found');

    const voidAttempt = await agentB.post(`${CREDIT_NOTES}/${noteA}/void`).send({});
    expect(voidAttempt.status).toBe(404);
  });
});
