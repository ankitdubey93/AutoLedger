import type { Readable } from 'node:stream';
import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import * as organizationService from '../organizationService.js';
import * as organizationProfileService from '../organizationProfileService.js';
import * as documentService from '../documentService.js';
import * as invoiceSettingsService from './invoiceSettingsService.js';
import * as partyLedgerService from './partyLedgerService.js';
import * as statementService from './statementService.js';
import * as statementSettingsService from './statementSettingsService.js';
import * as onlinePaymentService from './onlinePaymentService.js';
import { resolveLiveSend, type LiveSend, type PublicPaymentOptions } from './statementLinkService.js';

import type { OrganizationProfile } from '../../types/organization.js';
import type {
  PartyKind,
  PartyOpenItems,
  PartyStatement,
  StatementSettings,
} from '../../types/accounting.js';

/**
 * The public side of an emailed statement (Phase 39b): what the "Review and
 * pay" / "View statement" link opens, with no session.
 *
 * The token in the URL is the only credential (statementLinkService); every
 * read after resolving it is scoped by the `org_id` the matching
 * `statement_sends` row carries (rule 1) — the token picks the tenant,
 * nothing in the request can.
 */

function sentRequest(send: LiveSend): statementService.StatementRequest {
  if (send.statementType === 'ACTIVITY' && send.from !== null && send.to !== null) {
    return { type: 'ACTIVITY', from: send.from, to: send.to };
  }
  return { type: 'OUTSTANDING', asOf: send.asOf ?? statementService.todayIso() };
}

/** Mirrors the client's `addressLines` (InvoiceDocument.tsx) so the public page needs no profile. */
export function addressLines(profile: OrganizationProfile): string[] {
  const locality = [profile.city, profile.region, profile.postalCode].filter((p) => p !== null && p !== '').join(' ');
  return [
    profile.streetAddress1,
    profile.streetAddress2,
    locality === '' ? null : locality,
    profile.countryCode,
    profile.phone,
    profile.contactEmail,
    profile.website,
  ].filter((line): line is string => line !== null && line !== '');
}

export interface PublicStatementView {
  merchant: { name: string; addressLines: string[]; hasLogo: boolean; baseCurrency: string };
  partyKind: PartyKind;
  partyName: string;
  /** The statement exactly as it was sent (type and dates), recomputed now. */
  statement: PartyStatement;
  /** What is open today — what a customer can pay. */
  current: PartyOpenItems;
  settings: StatementSettings;
  bankDetails: string | null;
  payment: PublicPaymentOptions;
  expiresAt: string;
}


/** GET /public/statements/:token */
export async function getPublicStatement(token: string): Promise<PublicStatementView> {
  const send = await resolveLiveSend(token);
  const today = statementService.todayIso();

  const [organization, profile, settings, invoiceSettings, statement, current, payment] = await Promise.all([
    organizationService.getById(send.orgId),
    organizationProfileService.getProfile(send.orgId),
    statementSettingsService.getStatementSettings(send.orgId),
    invoiceSettingsService.getInvoiceSettings(send.orgId),
    statementService.getStatement(send.orgId, send.partyKind, send.partyId, sentRequest(send)),
    partyLedgerService.partyOpenItemsAsOf(send.orgId, send.partyKind, send.partyId, today),
    onlinePaymentService.paymentOptionsFor(send),
  ]);

  await pool.query('UPDATE statement_sends SET last_viewed_at = now() WHERE org_id = $1 AND id = $2', [
    send.orgId,
    send.id,
  ]);

  return {
    merchant: {
      name: organization.name,
      addressLines: settings.showOrgAddress ? addressLines(profile) : [],
      hasLogo: settings.showLogo && profile.logoDocumentId !== null,
      baseCurrency: organization.baseCurrency,
    },
    partyKind: send.partyKind,
    partyName: statement.party.name,
    statement,
    current,
    settings,
    bankDetails: invoiceSettings.bankDetails,
    payment,
    expiresAt: send.expiresAt,
  };
}

/** Only raster images are served from a public link — never SVG (script), never a PDF. */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** GET /public/statements/:token/logo */
export async function openPublicLogo(
  token: string,
): Promise<{ mimeType: string; byteSize: number; stream: Readable }> {
  const send = await resolveLiveSend(token);
  const profile = await organizationProfileService.getProfile(send.orgId);
  if (profile.logoDocumentId === null) throw new ApiError(404, 'No logo');
  const { document, stream } = await documentService.openDocumentStream(send.orgId, profile.logoDocumentId);
  if (!LOGO_TYPES.has(document.mimeType)) {
    stream.destroy();
    throw new ApiError(404, 'No logo');
  }
  return { mimeType: document.mimeType, byteSize: document.byteSize, stream };
}
