import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer } from '../helpers/accountingFixtures.js';
import { createVendor, isoDaysFromNow, requestDeposit, TODAY } from '../helpers/depositFixtures.js';

/**
 * GST codes and tax-inclusive pricing (Phase 49b). Integration tier, real PostgreSQL.
 *
 * The central claims: the code decides the rate, whatever the client sends; a
 * generic organization is untouched and refuses both features; inclusive
 * arithmetic survives every path from one document to the next; and nothing
 * posts without a code.
 */

const app = createApp();
const ACTIVATE = {
  gst: { registered: true, basis: 'ACCRUAL', basCycle: 'QUARTERLY', basMethod: 'FULL' },
  timezone: 'Australia/Sydney',
};

type Agent = Awaited<ReturnType<typeof loginAgent>>;

let userA: SeededUser;
let userB: SeededUser;
let agentA: Agent;
let agentB: Agent;
let customer: string;
let vendor: string;
let revenue: string;
let expense: string;

function invoiceBody(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    customerId: customer,
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    notes: null,
    paymentTerms: null,
    lines: lines.map((l) => ({ description: 'Work', quantityMilli: 1000, revenueAccountId: revenue, ...l })),
    ...extra,
  };
}

function billBody(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    vendorId: vendor,
    vendorReference: `REF-${String(Math.random())}`,
    billDate: '2026-08-01',
    dueDate: '2026-08-31',
    notes: null,
    paymentTerms: null,
    lines: lines.map((l) => ({ description: 'Supplies', quantityMilli: 1000, expenseAccountId: expense, ...l })),
    ...extra,
  };
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'a' });
  userB = await createUserWithOrg({ label: 'b' });
  agentA = await loginAgent(app, userA);
  agentB = await loginAgent(app, userB);
  expect((await agentA.post('/api/v1/settings/region/australia').send(ACTIVATE)).status).toBe(200);
  customer = await createCustomer(agentA, 'Harbour Cafe');
  vendor = await createVendor(agentA, 'Coastal Supplies');
  revenue = await accountId(userA.orgId, '4100');
  expense = await accountId(userA.orgId, '6130');
});

afterAll(async () => {
  await closePool();
});

describe('the catalogue', () => {
  it('is served to an Australian organization and refused to a generic one', async () => {
    const res = await agentA.get('/api/v1/tax-codes');
    expect(res.status).toBe(200);
    expect(res.body.codes.map((c: { code: string }) => c.code)).toContain('P_CAP_GST');
    expect((await agentB.get('/api/v1/tax-codes')).status).toBe(403);
  });
});

describe('the code decides the rate', () => {
  it('ignores a client-sent rate', async () => {
    const free = await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 10000, taxRateBp: 1000, taxCode: 'S_FREE' }]));
    expect(free.status).toBe(201);
    expect(free.body.invoice.taxCents).toBe(0);
    expect(free.body.invoice.lines[0].taxRateBp).toBe(0);
    expect(free.body.invoice.lines[0].taxCode).toBe('S_FREE');

    const taxed = await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 10000, taxRateBp: 0, taxCode: 'S_GST' }]));
    expect(taxed.body.invoice.taxCents).toBe(1000);
    expect(taxed.body.invoice.lines[0].taxRateBp).toBe(1000);
  });

  it('defaults to the item, then the account, then the region', async () => {
    const regionDefault = await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 10000 }]));
    expect(regionDefault.body.invoice.lines[0].taxCode).toBe('S_GST');

    const patched = await agentA.patch(`/api/v1/accounts/${revenue}`).send({ defaultTaxCode: 'S_EXPORT' });
    expect(patched.status).toBe(200);
    const accountDefault = await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 10000 }]));
    expect(accountDefault.body.invoice.lines[0].taxCode).toBe('S_EXPORT');

    const item = await agentA.post('/api/v1/items').send({
      code: 'BREAD',
      name: 'Bread',
      itemType: 'NON_INVENTORY',
      saleTaxCode: 'S_FREE',
    });
    expect(item.status).toBe(201);
    const itemDefault = await agentA
      .post('/api/v1/invoices')
      .send(invoiceBody([{ unitPriceCents: 10000, itemId: item.body.item.id }]));
    expect(itemDefault.body.invoice.lines[0].taxCode).toBe('S_FREE');
  });

  it('refuses an unknown code and one for the wrong direction', async () => {
    expect((await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 1, taxCode: 'NOPE' }]))).status).toBe(422);
    expect((await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 1, taxCode: 'P_GST' }]))).status).toBe(422);
    expect((await agentA.post('/api/v1/bills').send(billBody([{ unitPriceCents: 1, taxCode: 'S_GST' }]))).status).toBe(422);
  });

  it('limits an unregistered organization to BAS-excluded codes', async () => {
    await agentA.patch('/api/v1/settings/gst').send({ registered: false });
    const defaulted = await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 10000 }]));
    expect(defaulted.body.invoice.lines[0].taxCode).toBe('S_EXCLUDED');
    expect(defaulted.body.invoice.taxCents).toBe(0);
    expect((await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 1, taxCode: 'S_GST' }]))).status).toBe(422);
  });

  it('enforces the catalogue in the database too', async () => {
    await expect(
      pool.query(`UPDATE accounts SET default_tax_code = 'NOPE' WHERE org_id = $1 AND id = $2`, [userA.orgId, revenue]),
    ).rejects.toThrow(/chk_accounts_default_tax_code/);
  });
});

describe('a generic organization', () => {
  it('keeps free-typed rates, with no code stored', async () => {
    const c = await createCustomer(agentB, 'Northwind');
    const res = await agentB.post('/api/v1/invoices').send({
      customerId: c,
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'x', quantityMilli: 1000, unitPriceCents: 10000, taxRateBp: 750, revenueAccountId: await accountId(userB.orgId, '4100') }],
    });
    expect(res.status).toBe(201);
    expect(res.body.invoice.taxCents).toBe(750);
    expect(res.body.invoice.lines[0].taxCode).toBeNull();
    expect(res.body.invoice.taxMode).toBe('EXCLUSIVE');
  });

  it('refuses a GST code and inclusive pricing', async () => {
    const c = await createCustomer(agentB, 'Northwind');
    const base = {
      customerId: c,
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      notes: null,
      paymentTerms: null,
    };
    const line = { description: 'x', quantityMilli: 1000, unitPriceCents: 100, revenueAccountId: await accountId(userB.orgId, '4100') };
    expect((await agentB.post('/api/v1/invoices').send({ ...base, lines: [{ ...line, taxCode: 'S_GST' }] })).status).toBe(422);
    expect((await agentB.post('/api/v1/invoices').send({ ...base, taxMode: 'INCLUSIVE', lines: [line] })).status).toBe(422);
  });
});

describe('tax-inclusive pricing', () => {
  it('takes a $110 price apart into $100 and $10, and posts that', async () => {
    const created = await agentA
      .post('/api/v1/invoices')
      .send(invoiceBody([{ unitPriceCents: 11000, taxCode: 'S_GST' }], { taxMode: 'INCLUSIVE' }));
    expect(created.status).toBe(201);
    expect(created.body.invoice).toMatchObject({ subtotalCents: 10000, taxCents: 1000, totalCents: 11000, taxMode: 'INCLUSIVE' });
    expect(created.body.invoice.lines[0]).toMatchObject({ unitPriceCents: 11000, netCents: 10000, taxCents: 1000 });

    const issued = await agentA.post(`/api/v1/invoices/${created.body.invoice.id}/issue`).send({});
    expect(issued.status).toBe(200);
    const { rows } = await pool.query<{ code: string; credit: string }>(
      `SELECT a.code, l.base_credit_cents::text AS credit
         FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.journal_entry_id = $1 AND l.base_credit_cents > 0 ORDER BY a.code`,
      [issued.body.invoice.journalEntryId],
    );
    expect(rows).toEqual([
      { code: '2140', credit: '1000' },
      { code: '4100', credit: '10000' },
    ]);
  });

  it('keeps total exact on a mixed document, line by line', async () => {
    const res = await agentA.post('/api/v1/bills').send(
      billBody(
        [
          { unitPriceCents: 1999, taxCode: 'P_GST' },
          { unitPriceCents: 5000, taxCode: 'P_FREE' },
        ],
        { taxMode: 'INCLUSIVE' },
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.bill).toMatchObject({ taxCents: 182, subtotalCents: 6817, totalCents: 6999 });
  });

  async function expectTakenApart(doc: { subtotalCents: number; taxCents: number; taxMode: string; lines: { taxCode: string }[] }) {
    expect(doc).toMatchObject({ subtotalCents: 10000, taxCents: 1000, taxMode: 'INCLUSIVE' });
    expect(doc.lines[0]?.taxCode).toBe('S_GST');
  }

  it('survives a credit note, a quote revision, quote to invoice, order to invoice, and recurring', async () => {
    // credit note
    const inv = await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 11000, taxCode: 'S_GST' }], { taxMode: 'INCLUSIVE' }));
    await agentA.post(`/api/v1/invoices/${inv.body.invoice.id}/issue`).send({});
    const note = await agentA.post('/api/v1/credit-notes').send({
      invoiceId: inv.body.invoice.id,
      issueDate: '2026-08-02',
      reasonCode: 'RETURN',
      reason: null,
      notes: null,
      taxMode: 'INCLUSIVE',
      lines: [{ description: 'Back', quantityMilli: 1000, unitPriceCents: 11000, revenueAccountId: revenue, taxCode: 'S_GST' }],
    });
    expect(note.status).toBe(201);
    await expectTakenApart(note.body.creditNote);

    // quote, revision, conversion
    const quoteBody = {
      partyId: customer,
      quoteDate: TODAY,
      validUntil: isoDaysFromNow(30),
      partyReference: null,
      title: null,
      notes: null,
      paymentTerms: null,
      paymentTermsCode: 'NET_30',
      taxMode: 'INCLUSIVE',
      lines: [{ description: 'Job', quantityMilli: 1000, unitPriceCents: 11000, accountId: revenue, taxCode: 'S_GST', itemId: null }],
    };
    const newSentQuote = async (): Promise<string> => {
      const created = await agentA.post('/api/v1/quotes').send(quoteBody);
      expect(created.status).toBe(201);
      await expectTakenApart(created.body.quote);
      const id = created.body.quote.id as string;
      expect((await agentA.post(`/api/v1/quotes/${id}/send`).send({ delivery: 'MANUAL' })).status).toBe(200);
      return id;
    };

    const revised = await agentA.post(`/api/v1/quotes/${await newSentQuote()}/revise`).send({});
    expect(revised.status).toBeLessThan(300);
    await expectTakenApart(revised.body.quote);

    const accepted = await newSentQuote();
    expect((await agentA.post(`/api/v1/quotes/${accepted}/accept`).send({ signerName: 'Jane Doe' })).status).toBe(200);
    const converted = await agentA.post(`/api/v1/quotes/${accepted}/convert`).send({ target: 'INVOICE' });
    expect(converted.status).toBeLessThan(300);
    const fromQuote = await agentA.get(`/api/v1/invoices/${converted.body.document.id as string}`);
    await expectTakenApart(fromQuote.body.invoice);

    // order, then billing part of it
    const order = await agentA.post('/api/v1/orders').send({
      partyId: customer,
      orderDate: TODAY,
      taxMode: 'INCLUSIVE',
      lines: [{ description: 'Job', quantityMilli: 1000, unitPriceCents: 11000, accountId: revenue, taxCode: 'S_GST', itemId: null }],
    });
    expect(order.status).toBe(201);
    await expectTakenApart(order.body.order);
    const oid = order.body.order.id as string;
    expect((await agentA.post(`/api/v1/orders/${oid}/confirm`).send({})).status).toBe(200);
    const billed = await agentA.post(`/api/v1/orders/${oid}/convert`).send({});
    expect(billed.status).toBe(201);
    const fromOrder = await agentA.get(`/api/v1/invoices/${billed.body.document.id as string}`);
    await expectTakenApart(fromOrder.body.invoice);

    // a recurring run from an inclusive template
    const template = await agentA.post('/api/v1/invoices').send(
      invoiceBody([{ unitPriceCents: 11000, taxCode: 'S_GST' }], { taxMode: 'INCLUSIVE', issueDate: TODAY, dueDate: isoDaysFromNow(30) }),
    );
    const schedule = await agentA.post('/api/v1/recurring-schedules').send({
      kind: 'INVOICE',
      sourceId: template.body.invoice.id,
      name: 'Retainer',
      frequency: 'MONTHLY',
      startDate: TODAY,
    });
    expect(schedule.status).toBe(201);
    const run = await agentA.post(`/api/v1/recurring-schedules/${schedule.body.schedule.id as string}/run`).send({});
    expect(run.status).toBeLessThan(300);
    const { rows } = await pool.query<{ tax_cents: string; tax_mode: string; tax_code: string }>(
      `SELECT i.tax_cents::text, i.tax_mode, l.tax_code
         FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
        WHERE i.org_id = $1 AND i.id <> $2 AND i.issue_date = $3 AND i.status = 'DRAFT' AND i.source_quote_id IS NULL AND i.sales_order_id IS NULL
        ORDER BY i.created_at DESC LIMIT 1`,
      [userA.orgId, template.body.invoice.id, TODAY],
    );
    expect(rows[0]).toEqual({ tax_cents: '1000', tax_mode: 'INCLUSIVE', tax_code: 'S_GST' });
  });

  it('refuses to issue a draft with an uncoded line', async () => {
    const created = await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 10000 }]));
    await pool.query(`ALTER TABLE invoice_lines DISABLE TRIGGER USER`);
    await pool.query(`UPDATE invoice_lines SET tax_code = NULL WHERE invoice_id = $1`, [created.body.invoice.id]);
    await pool.query(`ALTER TABLE invoice_lines ENABLE TRIGGER USER`);
    const issued = await agentA.post(`/api/v1/invoices/${created.body.invoice.id}/issue`).send({});
    expect(issued.status).toBe(422);
    expect(issued.body.error).toMatch(/GST code/);
  });

  it('leaves a deposit invoice out of it', async () => {
    const order = await agentA.post('/api/v1/orders').send({
      partyId: customer,
      orderDate: TODAY,
      lines: [{ description: 'Job', quantityMilli: 1000, unitPriceCents: 10000, accountId: revenue, taxCode: 'S_GST', itemId: null }],
    });
    const oid = order.body.order.id as string;
    expect((await agentA.post(`/api/v1/orders/${oid}/confirm`).send({})).status).toBe(200);
    const deposit = await requestDeposit(agentA, 'SALES', oid, { amountCents: 1000 });
    expect(deposit.status).toBe(201);
    const issued = await agentA.post(`/api/v1/invoices/${deposit.body.document.id as string}/issue`).send({});
    expect(issued.status).toBe(200);
    expect(issued.body.invoice.taxCents).toBe(0);
  });
});

describe('tenancy', () => {
  it('never resolves a default from another organization', async () => {
    const itemB = await agentB.post('/api/v1/items').send({ code: 'B', name: 'B', itemType: 'NON_INVENTORY', saleTaxCode: 'S_FREE' });
    expect(itemB.status).toBe(201);
    const res = await agentA.post('/api/v1/invoices').send(invoiceBody([{ unitPriceCents: 10000, itemId: itemB.body.item.id }]));
    // The foreign item is refused or, at worst, its default is not seen.
    if (res.status === 201) expect(res.body.invoice.lines[0].taxCode).toBe('S_GST');
    else expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
