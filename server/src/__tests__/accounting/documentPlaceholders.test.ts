import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import * as billService from '../../services/accounting/billService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, type Agent } from '../helpers/accountingFixtures.js';

/**
 * Phase 40 — Xero-style placeholders in documents. Integration tier, real
 * PostgreSQL. Filling on issue/approve/post (so none reaches a posted row),
 * recurring generation from the text as written, the vendor-reference
 * fallback and 409, over-long results (422, rolled back), the import/capture
 * opt-outs, and this feature's cross-tenant isolation cases (rule 15).
 *
 * Fixed past dates throughout, so month names never depend on when the
 * suite runs: a schedule whose start and end date are the same day
 * generates exactly one occurrence, on that day.
 */

const app = createApp();
const RECURRING = '/api/v1/recurring-schedules';
const INVOICES = '/api/v1/invoices';
const BILLS = '/api/v1/bills';
const JOURNALS = '/api/v1/journals';
const CREDIT_NOTES = '/api/v1/credit-notes';
const BANK_IMPORTS = '/api/v1/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/bank-transactions';

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;
let agentA: Agent;
let agentB: Agent;
let revenueA: string;
let expenseA: string;
let customerA: string;
let vendorA: string;

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'placeholders-a', orgName: 'Harbor Point' });
  userB = await createUserWithOrg({ label: 'placeholders-b', orgName: 'Other Books' });
  orgA = userA.orgId;
  orgB = userB.orgId;
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  revenueA = await accountId(orgA, '4100');
  expenseA = await accountId(orgA, '6120');
  customerA = (await agentA.post('/api/v1/customers').send({ name: 'Northwind Traders' })).body.customer.id as string;
  vendorA = (await agentA.post('/api/v1/vendors').send({ name: 'Acme Property' })).body.vendor.id as string;
});

afterAll(closePool);

async function draftInvoice(
  agent: Agent,
  customerId: string,
  revenueAccountId: string,
  fields: { notes?: string | null; description?: string; issueDate?: string },
): Promise<string> {
  const issueDate = fields.issueDate ?? '2026-06-15';
  const res = await agent.post(INVOICES).send({
    customerId,
    issueDate,
    dueDate: '2026-07-15',
    notes: fields.notes ?? null,
    paymentTerms: null,
    lines: [
      {
        description: fields.description ?? 'Consulting',
        quantityMilli: 1000,
        unitPriceCents: 10000,
        revenueAccountId,
        taxRateBp: 0,
      },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: invoice ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.invoice.id as string;
}

async function draftBill(
  agent: Agent,
  vendorId: string,
  expenseAccountId: string,
  fields: { vendorReference: string; notes?: string | null; description?: string },
): Promise<string> {
  const res = await agent.post(BILLS).send({
    vendorId,
    vendorReference: fields.vendorReference,
    billDate: '2026-06-15',
    dueDate: '2026-07-15',
    notes: fields.notes ?? null,
    paymentTerms: null,
    lines: [
      { description: fields.description ?? 'Rent', quantityMilli: 1000, unitPriceCents: 50000, expenseAccountId, taxRateBp: 0 },
    ],
  });
  if (res.status !== 201) throw new Error(`fixture: bill ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.bill.id as string;
}

/** A schedule that generates exactly one occurrence, on `date`. */
async function runOnce(
  agent: Agent,
  kind: 'INVOICE' | 'BILL' | 'JOURNAL',
  sourceId: string,
  mode: 'DRAFT' | 'POST',
  date = '2026-06-15',
): Promise<{ scheduleId: string; lastError: string | null; run: Record<string, string | null> | undefined }> {
  const created = await agent.post(RECURRING).send({
    kind,
    sourceId,
    name: `${kind} placeholders`,
    frequency: 'MONTHLY',
    startDate: date,
    endDate: date,
    mode,
  });
  if (created.status !== 201) throw new Error(`fixture: schedule ${created.status} ${JSON.stringify(created.body)}`);
  const scheduleId = created.body.schedule.id as string;
  const ran = await agent.post(`${RECURRING}/${scheduleId}/run`).send({});
  const detail = await agent.get(`${RECURRING}/${scheduleId}`);
  const runs = detail.body.schedule.runs as Array<Record<string, string | null>>;
  return { scheduleId, lastError: (ran.body.lastError as string | null) ?? null, run: runs[0] };
}

describe('invoices', () => {
  it('a hand-saved draft keeps its placeholders; issuing fills them, number included', async () => {
    const id = await draftInvoice(agentA, customerA, revenueA, {
      notes: 'Thanks [Contact Name] — [Invoice Number] from [Organisation Name], due [Due Date]',
      description: 'Retainer [Month] [Year]',
    });
    const draft = await agentA.get(`${INVOICES}/${id}`);
    expect(draft.body.invoice.notes).toBe(
      'Thanks [Contact Name] — [Invoice Number] from [Organisation Name], due [Due Date]',
    );

    const issued = await agentA.post(`${INVOICES}/${id}/issue`).send({});
    expect(issued.status).toBe(200);
    const invoice = issued.body.invoice;
    expect(invoice.notes).toBe(`Thanks Northwind Traders — ${invoice.invoiceNumber as string} from Harbor Point, due 15 Jul 2026`);
    expect(invoice.notesTemplate).toBe(
      'Thanks [Contact Name] — [Invoice Number] from [Organisation Name], due [Due Date]',
    );
    expect(invoice.lines[0].description).toBe('Retainer June 2026');
    expect(invoice.lines[0].descriptionTemplate).toBe('Retainer [Month] [Year]');

    // The journal entry's own description is system text, never filled.
    const entry = await agentA.get(`${JOURNALS}/${invoice.journalEntryId as string}`);
    expect(entry.body.entry.description).toBe(`Invoice ${invoice.invoiceNumber as string} — Northwind Traders`);
  });

  it('an escaped [[Month]] is issued as a literal [Month], even through a recurring draft', async () => {
    const templateId = await draftInvoice(agentA, customerA, revenueA, { notes: 'Type [[Month]] to get [Month]' });
    const { run } = await runOnce(agentA, 'INVOICE', templateId, 'DRAFT');
    const draft = (await agentA.get(`${INVOICES}/${run?.invoiceId ?? ''}`)).body.invoice;
    expect(draft.notes).toBe('Type [[Month]] to get June');

    const issued = await agentA.post(`${INVOICES}/${run?.invoiceId ?? ''}/issue`).send({});
    expect(issued.body.invoice.notes).toBe('Type [Month] to get June');
  });

  it('text without placeholders is untouched and records no template', async () => {
    const id = await draftInvoice(agentA, customerA, revenueA, { notes: 'See [attached] terms' });
    const issued = await agentA.post(`${INVOICES}/${id}/issue`).send({});
    expect(issued.body.invoice.notes).toBe('See [attached] terms');
    expect(issued.body.invoice.notesTemplate).toBeNull();
    expect(issued.body.invoice.lines[0].descriptionTemplate).toBeNull();
  });

  it('a result over the column limit is a 422 and leaves the draft, and its number, untouched', async () => {
    const longCustomer = (await agentA.post('/api/v1/customers').send({ name: 'N'.repeat(60) })).body.customer.id as string;
    const id = await draftInvoice(agentA, longCustomer, revenueA, { description: `${'x'.repeat(480)}[Contact Name]` });

    const res = await agentA.post(`${INVOICES}/${id}/issue`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Line 1's description is longer than 500 characters once placeholders are filled");

    const after = await agentA.get(`${INVOICES}/${id}`);
    expect(after.body.invoice.status).toBe('DRAFT');
    expect(after.body.invoice.invoiceNumber).toBeNull();
    expect(after.body.invoice.lines[0].description).toBe(`${'x'.repeat(480)}[Contact Name]`);
  });

  it('a recurring DRAFT fills dates and the run number, keeping [Invoice Number] for issue', async () => {
    const raw = 'Rent for [Month] [Year], run [Occurrence], ref [Invoice Number]';
    const templateId = await draftInvoice(agentA, customerA, revenueA, { notes: raw, description: '[Month+1] service' });

    const { run } = await runOnce(agentA, 'INVOICE', templateId, 'DRAFT');
    const generated = (await agentA.get(`${INVOICES}/${run?.invoiceId ?? ''}`)).body.invoice;
    expect(generated.status).toBe('DRAFT');
    expect(generated.notes).toBe('Rent for June 2026, run 1, ref [Invoice Number]');
    expect(generated.notesTemplate).toBe(raw);
    expect(generated.lines[0].description).toBe('July service');

    // The template itself is not touched by a run.
    expect((await agentA.get(`${INVOICES}/${templateId}`)).body.invoice.notes).toBe(raw);

    const issued = await agentA.post(`${INVOICES}/${run?.invoiceId ?? ''}/issue`).send({});
    expect(issued.body.invoice.notes).toBe(`Rent for June 2026, run 1, ref ${issued.body.invoice.invoiceNumber as string}`);
    // The text as written survives the second fill.
    expect(issued.body.invoice.notesTemplate).toBe(raw);
  });

  it('an ISSUED template still generates from its text as written', async () => {
    const templateId = await draftInvoice(agentA, customerA, revenueA, {
      notes: 'Period [Month]',
      issueDate: '2026-05-10',
    });
    const issued = await agentA.post(`${INVOICES}/${templateId}/issue`).send({});
    expect(issued.body.invoice.notes).toBe('Period May');

    const { run } = await runOnce(agentA, 'INVOICE', templateId, 'POST', '2026-06-15');
    const generated = (await agentA.get(`${INVOICES}/${run?.invoiceId ?? ''}`)).body.invoice;
    expect(generated.status).toBe('ISSUED');
    expect(generated.notes).toBe('Period June');
  });
});

describe('bills', () => {
  it('approving fills the reference, notes and lines', async () => {
    const id = await draftBill(agentA, vendorA, expenseA, {
      vendorReference: 'RENT-[Month]-[Year]',
      notes: 'From [Contact Name]',
      description: 'Office rent [Month]',
    });
    const res = await agentA.post(`${BILLS}/${id}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.bill.vendorReference).toBe('RENT-June-2026');
    expect(res.body.bill.vendorReferenceTemplate).toBe('RENT-[Month]-[Year]');
    expect(res.body.bill.notes).toBe('From Acme Property');
    expect(res.body.bill.lines[0].description).toBe('Office rent June');

    // The filled reference is what the journal entry names.
    const entry = await agentA.get(`${JOURNALS}/${res.body.bill.journalEntryId as string}`);
    expect(entry.body.entry.description).toBe('Bill RENT-June-2026 — Acme Property');
  });

  it('a manual approval whose filled reference is taken is a 409, and nothing changes', async () => {
    await draftBill(agentA, vendorA, expenseA, { vendorReference: 'RENT-June' });
    const id = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'RENT-[Month]' });

    const res = await agentA.post(`${BILLS}/${id}/approve`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Vendor reference "RENT-June" has already been entered for this vendor');
    const after = await agentA.get(`${BILLS}/${id}`);
    expect(after.body.bill.status).toBe('DRAFT');
    expect(after.body.bill.vendorReference).toBe('RENT-[Month]');
  });

  it('two drafts may share a reference with placeholders; uniqueness applies once each is filled', async () => {
    const first = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'RENT-[Month]' });
    const second = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'RENT-[Month]' });

    expect((await agentA.post(`${BILLS}/${first}/approve`).send({})).body.bill.vendorReference).toBe('RENT-June');
    const clash = await agentA.post(`${BILLS}/${second}/approve`).send({});
    expect(clash.status).toBe(409);

    // A reference without placeholders is still unique among drafts, exactly as before.
    await draftBill(agentA, vendorA, expenseA, { vendorReference: 'INV-9' });
    const duplicate = await agentA.post(BILLS).send({
      vendorId: vendorA,
      vendorReference: 'INV-9',
      billDate: '2026-06-15',
      dueDate: '2026-07-15',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'x', quantityMilli: 1000, unitPriceCents: 100, expenseAccountId: expenseA, taxRateBp: 0 }],
    });
    expect(duplicate.status).toBe(409);
  });

  it('recurring: a reference with placeholders is filled with no date suffix', async () => {
    const templateId = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'RENT-[Month]' });
    const { run } = await runOnce(agentA, 'BILL', templateId, 'POST');
    const bill = (await agentA.get(`${BILLS}/${run?.billId ?? ''}`)).body.bill;
    expect(bill.status).toBe('POSTED');
    expect(bill.vendorReference).toBe('RENT-June');
  });

  it('recurring: a taken filled reference falls back to the date suffix, then records a 409', async () => {
    const templateId = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'RENT-[Month]' });
    await draftBill(agentA, vendorA, expenseA, { vendorReference: 'RENT-June' });

    const first = await runOnce(agentA, 'BILL', templateId, 'DRAFT');
    expect(first.lastError).toBeNull();
    const bill = (await agentA.get(`${BILLS}/${first.run?.billId ?? ''}`)).body.bill;
    expect(bill.vendorReference).toBe('RENT-June-2026-06-15');

    // Both the filled text and its fallback now exist: the run fails with a
    // readable error on the schedule rather than a retried constraint violation.
    const second = await runOnce(agentA, 'BILL', templateId, 'DRAFT');
    expect(second.lastError).toBe('Vendor reference "RENT-June" has already been entered for this vendor');
    expect(second.run).toBeUndefined();
  });

  it('a reference without placeholders keeps the Phase 34b date suffix', async () => {
    const templateId = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'INV-500' });
    const { run } = await runOnce(agentA, 'BILL', templateId, 'DRAFT');
    expect((await agentA.get(`${BILLS}/${run?.billId ?? ''}`)).body.bill.vendorReference).toBe('INV-500-2026-06-15');
  });

  it('a bill approved with filling off (capture, import) keeps its text as written', async () => {
    const id = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'OCR-[Month]', description: 'Scanned [Month]' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await billService.approveBillOnClient(client, orgA, userA.id, id, null, { fillPlaceholders: false });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const bill = (await agentA.get(`${BILLS}/${id}`)).body.bill;
    expect(bill.status).toBe('POSTED');
    expect(bill.vendorReference).toBe('OCR-[Month]');
    expect(bill.lines[0].description).toBe('Scanned [Month]');
  });
});

describe('journals', () => {
  async function postJournal(description: string, entryDate = '2026-06-15') {
    return agentA.post(JOURNALS).send({
      entryDate,
      description,
      lines: [
        { accountId: expenseA, debitCents: 5000, creditCents: 0 },
        { accountId: await accountId(orgA, '2120'), debitCents: 0, creditCents: 5000 },
      ],
    });
  }

  it('a manual entry is posted with its placeholders filled and the text as written kept', async () => {
    const res = await postJournal('AWS [Month] [Year] — [Organisation Name]');
    expect(res.status).toBe(201);
    expect(res.body.entry.description).toBe('AWS June 2026 — Harbor Point');
    expect(res.body.entry.descriptionTemplate).toBe('AWS [Month] [Year] — [Organisation Name]');
  });

  it('a recurring journal fills afresh from the posted template', async () => {
    const template = await postJournal('Accrual [Month] #[Occurrence]', '2026-05-15');
    expect(template.body.entry.description).toBe('Accrual May #');

    const { run } = await runOnce(agentA, 'JOURNAL', template.body.entry.id as string, 'POST');
    const entry = (await agentA.get(`${JOURNALS}/${run?.journalEntryId ?? ''}`)).body.entry;
    expect(entry.description).toBe('Accrual June #1');
    expect(entry.descriptionTemplate).toBe('Accrual [Month] #[Occurrence]');
  });
});

describe('credit notes', () => {
  it('issuing fills notes and lines, [Invoice Number] being the original invoice', async () => {
    const invoiceId = await draftInvoice(agentA, customerA, revenueA, {});
    const issued = await agentA.post(`${INVOICES}/${invoiceId}/issue`).send({});
    const created = await agentA.post(CREDIT_NOTES).send({
      invoiceId,
      issueDate: '2026-06-20',
      reasonCode: 'PRICE_ADJUSTMENT',
      notes: 'Credit for [Invoice Number], [Contact Name]',
      lines: [{ description: 'Discount [Month]', quantityMilli: 1000, unitPriceCents: 1000, revenueAccountId: revenueA, taxRateBp: 0 }],
    });
    expect(created.status).toBe(201);
    const res = await agentA.post(`${CREDIT_NOTES}/${created.body.creditNote.id as string}/issue`).send({});
    expect(res.status).toBe(200);
    expect(res.body.creditNote.notes).toBe(`Credit for ${issued.body.invoice.invoiceNumber as string}, Northwind Traders`);
    expect(res.body.creditNote.lines[0].description).toBe('Discount June');
  });
});

describe('bank lines', () => {
  it('a written description is filled against the line date; the bank text never is', async () => {
    const cash = await accountId(orgA, '1110');
    await agentA.post(BANK_IMPORTS).send({
      accountId: cash,
      fileName: 'one.csv',
      content: 'Date,Description,Amount\n2026-06-03,FEE [Month],-12.00\n2026-06-04,OTHER [Month],-5.00',
      dateFormat: 'ISO',
    });
    const list = await agentA.get(`${BANK_TRANSACTIONS}?accountId=${cash}&status=UNMATCHED&limit=100`);
    const txns = list.body.transactions as Array<{ id: string; description: string }>;
    const fee = txns.find((t) => t.description === 'FEE [Month]');
    const other = txns.find((t) => t.description === 'OTHER [Month]');

    const written = await agentA
      .post(`${BANK_TRANSACTIONS}/${fee?.id ?? ''}/post-journal`)
      .send({ accountId: await accountId(orgA, '6600'), description: 'Bank fee [Month] [Year]' });
    const bankText = await agentA
      .post(`${BANK_TRANSACTIONS}/${other?.id ?? ''}/post-journal`)
      .send({ accountId: await accountId(orgA, '6600'), description: null });

    const entryOf = async (res: typeof written) =>
      (await agentA.get(`${JOURNALS}/${res.body.transaction.matchedJournalEntryId as string}`)).body.entry;
    expect((await entryOf(written)).description).toBe('Bank fee June 2026');
    expect((await entryOf(bankText)).description).toBe('OTHER [Month]');
  });
});

describe('cross-tenant isolation', () => {
  it('names resolve from the issuing org only', async () => {
    // Org B has a customer with the same name and a different org name.
    await agentB.post('/api/v1/customers').send({ name: 'Northwind Traders' });
    const id = await draftInvoice(agentA, customerA, revenueA, { notes: '[Organisation Name] → [Contact Name]' });
    const issued = await agentA.post(`${INVOICES}/${id}/issue`).send({});
    expect(issued.body.invoice.notes).toBe('Harbor Point → Northwind Traders');
  });

  it("org B cannot issue or approve org A's drafts (404), and nothing is filled", async () => {
    const invoiceId = await draftInvoice(agentA, customerA, revenueA, { notes: '[Month]' });
    const billId = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'X-[Month]' });
    expect((await agentB.post(`${INVOICES}/${invoiceId}/issue`).send({})).status).toBe(404);
    expect((await agentB.post(`${BILLS}/${billId}/approve`).send({})).status).toBe(404);
    expect((await agentA.get(`${INVOICES}/${invoiceId}`)).body.invoice.notes).toBe('[Month]');
    expect((await agentA.get(`${BILLS}/${billId}`)).body.bill.vendorReference).toBe('X-[Month]');
  });

  it("another org's bill with the same filled reference does not force a fallback", async () => {
    const vendorB = (await agentB.post('/api/v1/vendors').send({ name: 'Acme Property' })).body.vendor.id as string;
    await draftBill(agentB, vendorB, await accountId(orgB, '6120'), { vendorReference: 'RENT-June' });

    const id = await draftBill(agentA, vendorA, expenseA, { vendorReference: 'RENT-[Month]' });
    const res = await agentA.post(`${BILLS}/${id}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.bill.vendorReference).toBe('RENT-June');
  });
});
