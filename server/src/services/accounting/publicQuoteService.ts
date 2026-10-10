import type { Readable } from 'node:stream';
import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { sha256Hex } from '../../utils/pkce.js';
import * as organizationService from '../organizationService.js';
import * as organizationProfileService from '../organizationProfileService.js';
import * as documentService from '../documentService.js';
import { addressLines } from './publicStatementService.js';
import * as quoteService from './quoteService.js';
import type { PublicQuoteView, QuoteDirection } from '../../types/accounting.js';

/**
 * Phase 41 — the public side of an emailed quote: what the "Review and
 * accept" / "Review and confirm" link opens, with no session.
 *
 * The token in the URL is the only credential. It is looked up by its
 * SHA-256 hash — never stored, never logged — and an unknown, expired or
 * revoked token is one indistinguishable 404. `resolveLiveQuoteLink` is the
 * only org-less query in the quote module; every read and write after it is
 * scoped by the `org_id` the matching `quote_links` row carries (rule 1) —
 * the token picks the tenant, nothing in the request can.
 */

interface LiveQuoteLink {
  id: string;
  orgId: string;
  quoteId: string;
  direction: QuoteDirection;
}

const NOT_VALID = 'This quote link is not valid or has expired';

/** Resolves a raw link token to its link, or 404s. The only org-less query in the module. */
export async function resolveLiveQuoteLink(token: string): Promise<LiveQuoteLink> {
  if (token.length < 20 || token.length > 200) throw new ApiError(404, NOT_VALID);
  const { rows } = await pool.query<{ id: string; org_id: string; quote_id: string; direction: QuoteDirection }>(
    `SELECT l.id, l.org_id, l.quote_id, q.direction
       FROM quote_links l
       JOIN quotes q ON q.id = l.quote_id AND q.org_id = l.org_id
      WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now()`,
    [sha256Hex(token)],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, NOT_VALID);
  return { id: row.id, orgId: row.org_id, quoteId: row.quote_id, direction: row.direction };
}

/** GET /public/quotes/:token — the frozen quote, and whether the viewer may still answer it. */
export async function getPublicQuote(token: string): Promise<PublicQuoteView> {
  const link = await resolveLiveQuoteLink(token);
  const [quote, organization, profile] = await Promise.all([
    quoteService.getQuoteById(link.orgId, link.direction, link.quoteId),
    organizationService.getById(link.orgId),
    organizationProfileService.getProfile(link.orgId),
  ]);
  // A link exists only for a sent quote, so both are set; guard anyway.
  if (quote.quoteNumber === null || quote.contentSha256 === null) throw new ApiError(404, NOT_VALID);

  await pool.query('UPDATE quote_links SET last_viewed_at = now() WHERE org_id = $1 AND id = $2', [
    link.orgId,
    link.id,
  ]);

  return {
    merchant: {
      name: organization.name,
      addressLines: addressLines(profile),
      hasLogo: profile.logoDocumentId !== null,
    },
    direction: quote.direction,
    quoteNumber: quote.quoteNumber,
    revision: quote.revision,
    effectiveStatus: quote.effectiveStatus,
    canRespond: quote.effectiveStatus === 'SENT',
    partyName: quote.partyNameSnapshot,
    partyAddress: quote.partyAddressSnapshot,
    partyTaxNumber: quote.partyTaxNumberSnapshot,
    partyReference: quote.partyReference,
    quoteDate: quote.quoteDate,
    validUntil: quote.validUntil,
    currencyCode: quote.currencyCode,
    title: quote.title,
    notes: quote.notes,
    terms: quote.terms,
    paymentTerms: quote.paymentTerms,
    lines: quote.lines.map((l) => ({
      lineNumber: l.lineNumber,
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      taxRateBp: l.taxRateBp,
      netCents: l.netCents,
      taxCents: l.taxCents,
    })),
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    contentSha256: quote.contentSha256,
    // Who signed and when — never the IP or user agent, which stay internal.
    response:
      quote.response === null
        ? null
        : {
            response: quote.response.response,
            signerName: quote.response.signerName,
            respondedAt: quote.response.respondedAt,
          },
  };
}

/** Only raster images are served from a public link — never SVG (script), never a PDF. */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** GET /public/quotes/:token/logo */
export async function openPublicQuoteLogo(
  token: string,
): Promise<{ mimeType: string; byteSize: number; stream: Readable }> {
  const link = await resolveLiveQuoteLink(token);
  const profile = await organizationProfileService.getProfile(link.orgId);
  if (profile.logoDocumentId === null) throw new ApiError(404, 'No logo');
  const { document, stream } = await documentService.openDocumentStream(link.orgId, profile.logoDocumentId);
  if (!LOGO_TYPES.has(document.mimeType)) {
    stream.destroy();
    throw new ApiError(404, 'No logo');
  }
  return { mimeType: document.mimeType, byteSize: document.byteSize, stream };
}

export interface ResponseClient {
  ip: string | null;
  userAgent: string | null;
}

export interface PublicAcceptInput {
  signerName: string;
  signerEmail: string | null;
  acceptTerms: true;
  contentSha256: string;
}

/**
 * POST /public/quotes/:token/accept. The signer's typed name, their
 * explicit acceptance of the terms, their IP and user agent, and the hash of
 * the exact content they were shown are written as insert-only evidence in
 * the same transaction as the transition. A changed quote (hash mismatch),
 * an expired one, or one already answered is a 409.
 */
export async function acceptPublicQuote(
  token: string,
  input: PublicAcceptInput,
  from: ResponseClient,
): Promise<PublicQuoteView> {
  const link = await resolveLiveQuoteLink(token);
  await quoteService.runQuoteWrite((client) =>
    quoteService.respondOnClient(client, link.orgId, link.quoteId, {
      response: 'ACCEPTED',
      channel: 'PUBLIC_LINK',
      linkId: link.id,
      signerName: input.signerName,
      signerEmail: input.signerEmail,
      termsAccepted: input.acceptTerms,
      declineReason: null,
      clientIp: from.ip,
      userAgent: from.userAgent,
      recordedBy: null,
      note: null,
      expectedContentSha256: input.contentSha256,
    }),
  );
  return getPublicQuote(token);
}

/** POST /public/quotes/:token/decline */
export async function declinePublicQuote(
  token: string,
  reason: string | null,
  from: ResponseClient,
): Promise<PublicQuoteView> {
  const link = await resolveLiveQuoteLink(token);
  await quoteService.runQuoteWrite((client) =>
    quoteService.respondOnClient(client, link.orgId, link.quoteId, {
      response: 'DECLINED',
      channel: 'PUBLIC_LINK',
      linkId: link.id,
      signerName: null,
      signerEmail: null,
      termsAccepted: false,
      declineReason: reason,
      clientIp: from.ip,
      userAgent: from.userAgent,
      recordedBy: null,
      note: null,
      expectedContentSha256: null,
    }),
  );
  return getPublicQuote(token);
}
