import type { Readable } from 'node:stream';
import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import * as organizationService from '../organizationService.js';
import * as organizationProfileService from '../organizationProfileService.js';
import * as documentService from '../documentService.js';
import * as stripeClient from '../payments/stripeClient.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import * as invoiceService from './invoiceService.js';
import { resolveLiveInvoiceSend } from './invoiceLinkService.js';
import { onlineCardAvailableOnClient } from './onlinePaymentService.js';
import { buildInvoicePdf } from './invoicePdfService.js';
import { addressLines, LOGO_TYPES } from './publicStatementService.js';
import type { PublicPaymentOptions } from './statementLinkService.js';
import type { SettlementStatus } from '../../types/accounting.js';

/**
 * The public side of an emailed invoice (Phase 48): what the "View and pay"
 * link opens, with no session.
 *
 * The token is the only credential (invoiceLinkService); every read after
 * resolving it is scoped by the `org_id` the matching `invoice_sends` row
 * carries (rule 1) — the token picks the tenant, nothing in the request can.
 * The view is mapped field by field, never a spread of an `Invoice`, so no
 * account id, journal id, creator or base-currency amount can leak.
 */

export interface PublicInvoiceView {
  merchant: { name: string; addressLines: string[]; hasLogo: boolean };
  invoice: {
    number: string | null;
    status: string;
    settlementStatus: SettlementStatus;
    issueDate: string;
    dueDate: string;
    currencyCode: string;
    customerName: string;
    notes: string | null;
    paymentTerms: string | null;
    lines: { description: string; quantityMilli: number; unitPriceCents: number; taxRateBp: number; netCents: number }[];
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    paidCents: number;
    amountDueCents: number;
  };
  bankDetails: string | null;
  payment: PublicPaymentOptions;
  expiresAt: string;
}

/** GET /public/invoices/:token */
export async function getPublicInvoice(token: string): Promise<PublicInvoiceView> {
  const send = await resolveLiveInvoiceSend(token);

  const [invoice, organization, profile, settings] = await Promise.all([
    invoiceService.getInvoiceById(send.orgId, send.invoiceId),
    organizationService.getById(send.orgId),
    organizationProfileService.getProfile(send.orgId),
    invoiceSettingsService.getInvoiceSettings(send.orgId),
  ]);

  const issued = invoice.status === 'ISSUED';
  const amountDueCents = issued ? invoice.amountDueCents : 0;
  const cardAvailable = await onlineCardAvailableOnClient(pool, send.orgId);
  const enabled = cardAvailable && amountDueCents > 0;
  const publishableKey = enabled ? (stripeClient.stripeConfig()?.publishableKey ?? null) : null;

  await pool.query('UPDATE invoice_sends SET last_viewed_at = now() WHERE org_id = $1 AND id = $2', [
    send.orgId,
    send.id,
  ]);

  return {
    merchant: {
      name: organization.name,
      addressLines: settings.showOrgAddress ? addressLines(profile) : [],
      hasLogo: settings.showLogo && profile.logoDocumentId !== null,
    },
    invoice: {
      number: invoice.invoiceNumber,
      status: invoice.status,
      settlementStatus: invoice.settlementStatus,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currencyCode: invoice.currencyCode,
      customerName: invoice.customerNameSnapshot,
      notes: invoice.notes,
      paymentTerms: invoice.paymentTerms,
      lines: invoice.lines.map((l) => ({
        description: l.description,
        quantityMilli: l.quantityMilli,
        unitPriceCents: l.unitPriceCents,
        taxRateBp: l.taxRateBp,
        netCents: l.netCents,
      })),
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      paidCents: issued ? invoice.allocatedCents + invoice.creditedCents + invoice.depositAppliedCents : 0,
      amountDueCents,
    },
    bankDetails: settings.bankDetails,
    payment: { enabled: publishableKey !== null, publishableKey },
    expiresAt: send.expiresAt,
  };
}

/** GET /public/invoices/:token/logo */
export async function openPublicInvoiceLogo(
  token: string,
): Promise<{ mimeType: string; byteSize: number; stream: Readable }> {
  const send = await resolveLiveInvoiceSend(token);
  const [profile, settings] = await Promise.all([
    organizationProfileService.getProfile(send.orgId),
    invoiceSettingsService.getInvoiceSettings(send.orgId),
  ]);
  if (!settings.showLogo || profile.logoDocumentId === null) throw new ApiError(404, 'No logo');
  const { document, stream } = await documentService.openDocumentStream(send.orgId, profile.logoDocumentId);
  if (!LOGO_TYPES.has(document.mimeType)) {
    stream.destroy();
    throw new ApiError(404, 'No logo');
  }
  return { mimeType: document.mimeType, byteSize: document.byteSize, stream };
}

/** GET /public/invoices/:token/pdf */
export async function getPublicInvoicePdf(token: string): Promise<{ filename: string; pdf: Buffer }> {
  const send = await resolveLiveInvoiceSend(token);
  return buildInvoicePdf(send.orgId, await invoiceService.getInvoiceById(send.orgId, send.invoiceId));
}
