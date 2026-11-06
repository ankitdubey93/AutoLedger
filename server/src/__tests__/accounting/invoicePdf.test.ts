import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import type { Response } from 'supertest';
import { createApp } from '../../app.js';
import { closePool } from '../../db/connect.js';
import { addMember, createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';
import { createCustomer, issueCreditNote, issueInvoice, type Agent } from '../helpers/accountingFixtures.js';
import {
  renderSalesDocumentPdf,
  type SalesDocumentPdfInput,
} from '../../services/accounting/invoicePdfRenderer.js';

function input(overrides: Partial<SalesDocumentPdfInput> = {}): SalesDocumentPdfInput {
  return {
    kind: 'INVOICE',
    merchantName: 'Org Alpha',
    merchantAddressLines: ['1 Main St', 'Springfield'],
    logo: null,
    number: 'INV-000012',
    status: 'ISSUED',
    partyName: 'Acme Ltd',
    partyAddress: null,
    partyTaxNumber: null,
    issueDate: '2026-10-10',
    dueDate: '2026-11-09',
    relatedNumber: null,
    currencyCode: 'USD',
    paymentTerms: null,
    notes: null,
    bankDetails: null,
    lines: [{ description: 'Design', quantityMilli: 2000, unitPriceCents: 10000, taxRateBp: 1500, netCents: 20000 }],
    subtotalCents: 20000,
    taxCents: 3000,
    totalCents: 23000,
    paidCents: null,
    amountDueCents: null,
    ...overrides,
  };
}

/** Decode pdfkit's hex TJ arrays back into visible text (same approach as quotePdf.test.ts). */
function visibleText(raw: string): string {
  const out: string[] = [];
  for (const m of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let line = '';
    for (const h of (m[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)) line += Buffer.from(h[1] ?? '', 'hex').toString('latin1');
    out.push(line);
  }
  return out.join('\n');
}

async function raw(i: SalesDocumentPdfInput): Promise<string> {
  return (await renderSalesDocumentPdf(i, { compress: false })).toString('latin1');
}

async function text(i: SalesDocumentPdfInput): Promise<string> {
  return visibleText(await raw(i));
}

describe('renderSalesDocumentPdf', () => {
  it('starts with %PDF-', async () => {
    const buf = await renderSalesDocumentPdf(input());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('a 100-line invoice paginates without throwing', async () => {
    const lines = Array.from({ length: 100 }, (_, n) => ({
      description: `Line ${String(n + 1)}`,
      quantityMilli: 1000,
      unitPriceCents: 100,
      taxRateBp: 0,
      netCents: 100,
    }));
    const out = await raw(input({ lines, subtotalCents: 10000, taxCents: 0, totalCents: 10000 }));
    const pages = out.match(/\/Type \/Page(?![s\w])/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });

  it('a null number renders DRAFT', async () => {
    expect(await text(input({ number: null }))).toContain('DRAFT');
  });

  it('a void invoice prints VOID', async () => {
    expect(await text(input({ status: 'VOID' }))).toContain('VOID');
  });

  it('a credit note is headed CREDIT NOTE', async () => {
    expect(await text(input({ kind: 'CREDIT_NOTE', relatedNumber: 'INV-000001' }))).toContain('CREDIT NOTE');
  });

  it('shows the amount due as integer cents ("123.45")', async () => {
    expect(await text(input({ paidCents: 10000, amountDueCents: 12345 }))).toContain('123.45');
  });

  it('corrupt logo bytes do not throw', async () => {
    const buf = await renderSalesDocumentPdf(input({ logo: Buffer.from('not an image') }));
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

const app = createApp();

/** supertest has no PDF parser registered: collect the body as a Buffer. */
function binary(res: Response, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });
}

describe('GET /invoices/:id/pdf and /credit-notes/:id/pdf', () => {
  let userA: SeededUser;
  let userB: SeededUser;
  let agentA: Agent;
  let agentB: Agent;
  let invoiceId: string;
  let creditNoteId: string;
  let invoiceNumber: string;

  beforeEach(async () => {
    await resetTables();
    userA = await createUserWithOrg({ label: 'pdf-a', orgName: 'Org A' });
    userB = await createUserWithOrg({ label: 'pdf-b', orgName: 'Org B' });
    agentA = await loginAgent(app, userA);
    agentB = await loginAgent(app, userB);
    const customer = await createCustomer(agentA, 'Acme Ltd', 'ap@acme.test');
    const invoice = await issueInvoice(agentA, userA.orgId, customer, 12345, '2026-06-01', '2026-06-30');
    invoiceId = invoice.id;
    invoiceNumber = invoice.number;
    creditNoteId = await issueCreditNote(agentA, userA.orgId, invoiceId, 1000, '2026-06-05');
  });

  afterAll(closePool);

  it('returns the invoice as a PDF', async () => {
    const res = await agentA.get(`/api/v1/invoices/${invoiceId}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(`${invoiceNumber}.pdf`);
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('returns the credit note as a PDF', async () => {
    const res = await agentA.get(`/api/v1/credit-notes/${creditNoteId}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it("org B cannot fetch org A's invoice or credit note (404)", async () => {
    expect((await agentB.get(`/api/v1/invoices/${invoiceId}/pdf`)).status).toBe(404);
    expect((await agentB.get(`/api/v1/credit-notes/${creditNoteId}/pdf`)).status).toBe(404);
  });

  it('a VIEWER can download an invoice PDF', async () => {
    const viewer = await createUserWithOrg({ label: 'pdf-viewer', orgName: 'Viewer Solo' });
    await addMember(userA.orgId, viewer.id, 'VIEWER');
    const agent = await loginAgent(app, viewer);
    await agent.post('/api/v1/auth/switch-org').send({ orgId: userA.orgId });
    const res = await agent.get(`/api/v1/invoices/${invoiceId}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
  });
});
