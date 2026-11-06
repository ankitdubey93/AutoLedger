import { pool } from '../../db/connect.js';
import { sellerFromSnapshot, sellerIdentityOnClient } from './taxCodeService.js';
import * as organizationService from '../organizationService.js';
import * as organizationProfileService from '../organizationProfileService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import * as invoiceService from './invoiceService.js';
import * as creditNoteService from './creditNoteService.js';
import { readLogoBytes } from './quoteService.js';
import { addressLines } from './publicStatementService.js';
import { renderSalesDocumentPdf } from './invoicePdfRenderer.js';
import type { Invoice } from '../../types/accounting.js';

/**
 * Phase 48 — invoice and credit-note PDFs. Every read goes through `orgId`
 * (guardrails rule 1); the render itself is pure (invoicePdfRenderer.ts).
 */

/** Renders an already-loaded invoice. Shared by the staff route, the public link and the mail attachment. */
export async function buildInvoicePdf(orgId: string, invoice: Invoice): Promise<{ filename: string; pdf: Buffer }> {
  const [organization, profile, settings] = await Promise.all([
    organizationService.getById(orgId),
    organizationProfileService.getProfile(orgId),
    invoiceSettingsService.getInvoiceSettings(orgId),
  ]);
  const logo = settings.showLogo ? await readLogoBytes(orgId, profile.logoDocumentId) : null;
  const seller = sellerFromSnapshot(invoice, await sellerIdentityOnClient(pool, orgId));
  const issued = invoice.status === 'ISSUED';
  const pdf = await renderSalesDocumentPdf({
    kind: 'INVOICE',
    merchantName: organization.name,
    merchantAddressLines: settings.showOrgAddress ? addressLines(profile) : [],
    logo,
    number: invoice.invoiceNumber,
    status: invoice.status,
    partyName: invoice.customerNameSnapshot,
    partyAddress: invoice.customerAddressSnapshot,
    partyTaxNumber: invoice.customerTaxNumberSnapshot,
    issueDate: invoice.issueDate,
    dueDate: settings.showDueDate ? invoice.dueDate : null,
    relatedNumber: null,
    currencyCode: invoice.currencyCode,
    paymentTerms: settings.showPaymentTerms ? invoice.paymentTerms : null,
    notes: invoice.notes,
    bankDetails: settings.bankDetails,
    lines: invoice.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      taxRateBp: l.taxRateBp,
      netCents: l.netCents,
      taxCents: l.taxCents,
    })),
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
    paidCents: issued ? invoice.allocatedCents + invoice.creditedCents + invoice.depositAppliedCents : null,
    amountDueCents: issued ? invoice.amountDueCents : null,
    gst: seller === null ? null : { registered: seller.gstRegistered, abn: seller.abn, legalName: seller.legalName, inclusive: invoice.taxMode === 'INCLUSIVE' },
  });
  const filename = invoice.invoiceNumber === null ? 'invoice-draft.pdf' : `${invoice.invoiceNumber}.pdf`;
  return { filename, pdf };
}

/** GET /invoices/:id/pdf */
export async function getInvoicePdf(orgId: string, id: string): Promise<{ filename: string; pdf: Buffer }> {
  return buildInvoicePdf(orgId, await invoiceService.getInvoiceById(orgId, id));
}

/** GET /credit-notes/:id/pdf */
export async function getCreditNotePdf(orgId: string, id: string): Promise<{ filename: string; pdf: Buffer }> {
  const note = await creditNoteService.getCreditNoteById(orgId, id);
  const [organization, profile, settings] = await Promise.all([
    organizationService.getById(orgId),
    organizationProfileService.getProfile(orgId),
    invoiceSettingsService.getInvoiceSettings(orgId),
  ]);
  const logo = settings.showLogo ? await readLogoBytes(orgId, profile.logoDocumentId) : null;
  const seller = sellerFromSnapshot(note, await sellerIdentityOnClient(pool, orgId));
  const pdf = await renderSalesDocumentPdf({
    kind: 'CREDIT_NOTE',
    merchantName: organization.name,
    merchantAddressLines: settings.showOrgAddress ? addressLines(profile) : [],
    logo,
    number: note.creditNoteNumber,
    status: note.status,
    partyName: note.customerNameSnapshot,
    partyAddress: note.customerAddressSnapshot,
    partyTaxNumber: note.customerTaxNumberSnapshot,
    issueDate: note.issueDate,
    dueDate: null,
    relatedNumber: note.invoiceNumber,
    currencyCode: note.currencyCode,
    paymentTerms: null,
    notes: note.notes,
    bankDetails: null,
    lines: note.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      taxRateBp: l.taxRateBp,
      netCents: l.netCents,
      taxCents: l.taxCents,
    })),
    subtotalCents: note.subtotalCents,
    taxCents: note.taxCents,
    totalCents: note.totalCents,
    paidCents: null,
    amountDueCents: null,
    gst:
      seller === null
        ? null
        : { registered: seller.gstRegistered, abn: seller.abn, legalName: seller.legalName, inclusive: note.taxMode === 'INCLUSIVE', reason: note.reason },
  });
  const filename = note.creditNoteNumber === null ? 'credit-note-draft.pdf' : `${note.creditNoteNumber}.pdf`;
  return { filename, pdf };
}

/** Passed to drainEmailOutbox by the worker. A missing invoice is an ApiError(404) from getInvoiceById. */
export async function resolveInvoiceAttachment(
  orgId: string,
  invoiceId: string,
): Promise<{ filename: string; contentType: 'application/pdf'; content: Buffer }> {
  const { filename, pdf } = await getInvoicePdf(orgId, invoiceId);
  return { filename, contentType: 'application/pdf', content: pdf };
}
