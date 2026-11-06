import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { renderSalesDocumentPdf, type SalesDocumentPdfInput } from '../../services/accounting/invoicePdfRenderer.js';
import { renderQuotePdf, type QuotePdfInput } from '../../services/accounting/quotePdfRenderer.js';
import { buildInvoicePdf } from '../../services/accounting/invoicePdfService.js';
import { getInvoiceById } from '../../services/accounting/invoiceService.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { accountId, createCustomer } from '../helpers/accountingFixtures.js';

/**
 * Tax invoices (Phase 49e).
 *
 * The central claims: a registered Australian seller's document says Tax Invoice
 * and shows the ABN and GST; an unregistered one must not; the seller is frozen
 * at issue; and a GENERIC organization's PDF is exactly what it was.
 */

const app = createApp();

function salesInput(overrides: Partial<SalesDocumentPdfInput> = {}): SalesDocumentPdfInput {
  return {
    kind: 'INVOICE',
    merchantName: 'Harbour Bakery',
    merchantAddressLines: ['1 Quay St'],
    logo: null,
    number: 'INV-1',
    status: 'ISSUED',
    partyName: 'Harbour Cafe',
    partyAddress: null,
    partyTaxNumber: null,
    issueDate: '2026-09-03',
    dueDate: '2026-10-03',
    relatedNumber: null,
    currencyCode: 'AUD',
    paymentTerms: null,
    notes: null,
    bankDetails: null,
    lines: [{ description: 'Bread', quantityMilli: 1000, unitPriceCents: 11000, taxRateBp: 1000, netCents: 10000, taxCents: 1000 }],
    subtotalCents: 10000,
    taxCents: 1000,
    totalCents: 11000,
    paidCents: null,
    amountDueCents: null,
    ...overrides,
  } as SalesDocumentPdfInput;
}

/** pdfkit writes text as hex-encoded glyphs, so compare a document's plain text through its own encoding. */
async function pdfText(input: SalesDocumentPdfInput): Promise<string> {
  const raw = (await renderSalesDocumentPdf(input, { compress: false })).toString('latin1');
  const hex = [...raw.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1] ?? '', 'hex').toString('latin1'));
  return hex.join('').replace(/\s+/g, ' ');
}

describe('the sales document PDF', () => {
  const registered = { registered: true, abn: '51 824 753 556', legalName: 'Harbour Bakery Pty Ltd', inclusive: false };

  it('says Tax Invoice with the ABN, GST, AU dates and a total statement', async () => {
    const text = await pdfText(salesInput({ gst: registered, partyTaxNumber: '11 222 333 444' }));
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain('ABN 51 824 753 556');
    expect(text).toContain('Harbour Bakery Pty Ltd');
    expect(text).toContain('ABN 11 222 333 444');
    expect(text).toContain('GST');
    expect(text).toContain('03/09/2026');
    expect(text).toContain('Total includes GST of');
  });

  it('never says Tax Invoice for an unregistered seller, and shows no GST row', async () => {
    const text = await pdfText(salesInput({ gst: { ...registered, registered: false }, taxCents: 0, totalCents: 10000 }));
    expect(text).not.toContain('TAX INVOICE');
    expect(text).toContain('INVOICE');
    expect(text).not.toContain('includes GST');
  });

  it('a credit note becomes an adjustment note, with its reason', async () => {
    const text = await pdfText(salesInput({ kind: 'CREDIT_NOTE', relatedNumber: 'INV-1', gst: { ...registered, reason: 'Goods returned' } }));
    expect(text).toContain('ADJUSTMENT NOTE');
    expect(text).toContain('REASON FOR ADJUSTMENT');
    expect(text).toContain('Goods returned');
  });

  it('shows the amount the buyer pays on an inclusive line', async () => {
    const text = await pdfText(salesInput({ gst: { ...registered, inclusive: true } }));
    expect(text).toContain('110.00');
  });

  it('is unchanged for a generic organization, byte for byte', async () => {
    const before = await renderSalesDocumentPdf(salesInput(), { compress: false });
    const after = await renderSalesDocumentPdf(salesInput({ gst: null }), { compress: false });
    const strip = (b: Buffer) => b.toString('latin1').replace(/\/CreationDate[^\n]*/g, '').replace(/\/ID[^\n]*/g, '');
    expect(strip(after)).toBe(strip(before));
    const text = await pdfText(salesInput());
    expect(text).toContain('INVOICE');
    expect(text).not.toContain('TAX INVOICE');
    expect(text).not.toContain('ABN');
    expect(text).toContain('2026-09-03');
  });
});

describe('the quote PDF', () => {
  it('stays a quote, with the ABN', async () => {
    const input: QuotePdfInput = {
      direction: 'SALES',
      merchantName: 'Harbour Bakery',
      merchantAddressLines: [],
      logo: null,
      quoteNumber: 'Q-1',
      revision: 1,
      quoteDate: '2026-09-03',
      validUntil: '2026-10-03',
      partyName: 'Harbour Cafe',
      partyAddress: null,
      partyTaxNumber: null,
      partyReference: null,
      title: null,
      currencyCode: 'AUD',
      paymentTerms: null,
      notes: null,
      terms: null,
      lines: [{ description: 'Bread', quantityMilli: 1000, unitPriceCents: 11000, taxRateBp: 1000, netCents: 10000, taxCents: 1000 }],
      subtotalCents: 10000,
      taxCents: 1000,
      totalCents: 11000,
      depositPercentBp: null,
      gst: { registered: true, abn: '51 824 753 556', inclusive: true },
    } as QuotePdfInput;
    const raw = (await renderQuotePdf(input, { compress: false })).toString('latin1');
    const text = [...raw.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1] ?? '', 'hex').toString('latin1')).join('');
    expect(text).toContain('QUOTE');
    expect(text).not.toContain('TAX INVOICE');
    expect(text).toContain('ABN 51 824 753 556');
    expect(text).toContain('03/09/2026');
    expect(text).toContain('110.00');
  });
});

describe('the seller snapshot', () => {
  let user: SeededUser;
  let agent: Awaited<ReturnType<typeof loginAgent>>;

  async function issued(): Promise<string> {
    const customer = await createCustomer(agent, 'Harbour Cafe');
    const created = await agent.post('/api/v1/invoices').send({
      customerId: customer,
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      notes: null,
      paymentTerms: null,
      lines: [{ description: 'Bread', quantityMilli: 1000, unitPriceCents: 10000, revenueAccountId: await accountId(user.orgId, '4100') }],
    });
    const id = created.body.invoice.id as string;
    expect((await agent.post(`/api/v1/invoices/${id}/issue`).send({})).status).toBe(200);
    return id;
  }

  beforeEach(async () => {
    await resetTables();
    user = await createUserWithOrg({ label: 'a' });
    agent = await loginAgent(app, user);
  });

  afterAll(async () => {
    await closePool();
  });

  it('freezes the ABN and registration at issue', async () => {
    await agent.post('/api/v1/settings/region/australia').send({
      gst: { registered: true, basis: 'ACCRUAL', basCycle: 'QUARTERLY', basMethod: 'FULL' },
      timezone: 'Australia/Sydney',
    });
    await pool.query(`UPDATE organizations SET tax_number = '51 824 753 556' WHERE id = $1`, [user.orgId]);
    const id = await issued();

    await pool.query(`UPDATE organizations SET tax_number = '99 999 999 999' WHERE id = $1`, [user.orgId]);
    await agent.patch('/api/v1/settings/gst').send({ registered: false });

    const invoice = await getInvoiceById(user.orgId, id);
    expect(invoice).toMatchObject({ sellerAbn: '51 824 753 556', sellerGstRegistered: true });
    const { pdf } = await buildInvoicePdf(user.orgId, invoice);
    expect(pdf.length).toBeGreaterThan(0);
  });

  it('stays empty for a generic organization', async () => {
    const id = await issued();
    const invoice = await getInvoiceById(user.orgId, id);
    expect(invoice).toMatchObject({ sellerAbn: null, sellerLegalName: null, sellerGstRegistered: null });
  });

  it("does not take its seller from another organization, or show across tenants", async () => {
    await agent.post('/api/v1/settings/region/australia').send({
      gst: { registered: true, basis: 'ACCRUAL', basCycle: 'QUARTERLY', basMethod: 'FULL' },
      timezone: 'Australia/Sydney',
    });
    await pool.query(`UPDATE organizations SET tax_number = '51 824 753 556' WHERE id = $1`, [user.orgId]);
    const id = await issued();

    const other = await createUserWithOrg({ label: 'b' });
    await pool.query(`UPDATE organizations SET tax_number = '99 999 999 999' WHERE id = $1`, [other.orgId]);
    const otherAgent = await loginAgent(app, other);
    expect((await otherAgent.get(`/api/v1/invoices/${id}/pdf`)).status).toBe(404);
    expect(await getInvoiceById(user.orgId, id)).toMatchObject({ sellerAbn: '51 824 753 556' });
  });

  it('is refused once issued, by the immutability trigger', async () => {
    const id = await issued();
    await expect(pool.query(`UPDATE invoices SET seller_abn = 'X' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
  });
});
