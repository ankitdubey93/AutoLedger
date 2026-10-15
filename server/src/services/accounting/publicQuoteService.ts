import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import {
  QUOTE_ACCEPTANCE_CODES_PER_HOUR,
  QUOTE_ACCEPTANCE_CODE_MAX_ATTEMPTS,
  QUOTE_ACCEPTANCE_CODE_TTL_MS,
} from '../../config/constants.js';
import { enqueueEmailOnClient } from '../mail/emailOutboxService.js';
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
    requiresEmailCode: await requiresEmailCode(link.orgId),
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
    depositPercentBp: quote.depositPercentBp,
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

/** GET /public/quotes/:token/pdf — the same frozen quote the page shows, as a PDF. */
export async function getPublicQuotePdf(token: string): Promise<{ filename: string; pdf: Buffer }> {
  const link = await resolveLiveQuoteLink(token);
  const quote = await quoteService.getQuoteById(link.orgId, link.direction, link.quoteId);
  if (quote.quoteNumber === null) throw new ApiError(404, NOT_VALID);
  return quoteService.buildQuotePdf(link.orgId, quote);
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
  /** The 6-digit code emailed to `signerEmail`, when verification is in play. */
  code: string | null;
}

async function requiresEmailCode(orgId: string): Promise<boolean> {
  const { rows } = await pool.query<{ required: boolean }>(
    'SELECT quote_acceptance_requires_code AS required FROM ledger_invoice_settings WHERE org_id = $1',
    [orgId],
  );
  return rows[0]?.required ?? false;
}

function codeHash(linkId: string, code: string): string {
  return sha256Hex(`${linkId}:${code}`);
}

function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * POST /public/quotes/:token/verify-email. Emails a fresh 6-digit code to the
 * address the signer typed. Only the hash is stored; the code itself travels
 * in the outbox row's data and never reaches a log. At most
 * QUOTE_ACCEPTANCE_CODES_PER_HOUR codes per link per hour.
 */
export async function requestAcceptanceCode(token: string, signerEmail: string): Promise<{ expiresAt: string }> {
  const link = await resolveLiveQuoteLink(token);
  const quote = await quoteService.getQuoteById(link.orgId, link.direction, link.quoteId);
  if (quote.effectiveStatus !== 'SENT' || quote.quoteNumber === null) {
    throw new ApiError(409, 'This quote is no longer open for a response');
  }
  const email = signerEmail.toLowerCase();
  return withTransaction(async (client) => {
    // Serialise concurrent requests for one link so the hourly cap cannot be raced.
    await client.query('SELECT 1 FROM quote_links WHERE org_id = $1 AND id = $2 FOR UPDATE', [link.orgId, link.id]);
    const { rows: counted } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM quote_acceptance_codes
        WHERE org_id = $1 AND link_id = $2 AND created_at > now() - interval '1 hour'`,
      [link.orgId, link.id],
    );
    if (Number(counted[0]?.n ?? '0') >= QUOTE_ACCEPTANCE_CODES_PER_HOUR) {
      throw new ApiError(429, 'Too many codes requested — try again later');
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const { rows } = await client.query<{ expires_at: Date }>(
      `INSERT INTO quote_acceptance_codes (org_id, link_id, signer_email, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'))
       RETURNING expires_at`,
      [link.orgId, link.id, email, codeHash(link.id, code), QUOTE_ACCEPTANCE_CODE_TTL_MS],
    );
    const { rows: orgRows } = await client.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [
      link.orgId,
    ]);
    await enqueueEmailOnClient(client, {
      orgId: link.orgId,
      to: email,
      template: 'quote_acceptance_code',
      data: {
        organizationName: orgRows[0]?.name ?? '',
        quoteNumber: quote.quoteNumber,
        code,
        minutes: Math.round(QUOTE_ACCEPTANCE_CODE_TTL_MS / 60_000),
      },
    });
    const expires = rows[0]?.expires_at;
    if (expires === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return { expiresAt: expires.toISOString() };
  });
}

interface CodeRow {
  id: string;
  code_hash: string;
  attempts: number;
}

async function lockNewestCodeOnClient(
  client: PoolClient,
  link: LiveQuoteLink,
  signerEmail: string,
): Promise<CodeRow | undefined> {
  const { rows } = await client.query<CodeRow>(
    `SELECT id, code_hash, attempts FROM quote_acceptance_codes
      WHERE org_id = $1 AND link_id = $2 AND signer_email = $3
        AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC, id
      LIMIT 1
      FOR UPDATE`,
    [link.orgId, link.id, signerEmail],
  );
  return rows[0];
}

/**
 * Transaction 1 of an accept: count the attempt and compare. Runs (and
 * commits) on its own so a wrong guess persists even though the request
 * then fails. Returns the failure to throw, or null when the code matched —
 * a match does NOT consume; `verifyAcceptanceCodeOnClient` does that inside
 * the accept transaction.
 */
async function bumpAttemptOnClient(
  client: PoolClient,
  link: LiveQuoteLink,
  signerEmail: string,
  code: string,
): Promise<ApiError | null> {
  const row = await lockNewestCodeOnClient(client, link, signerEmail);
  if (row === undefined) return new ApiError(422, 'Request a new verification code');
  if (row.attempts >= QUOTE_ACCEPTANCE_CODE_MAX_ATTEMPTS) {
    return new ApiError(422, 'Too many attempts — request a new code');
  }
  await client.query('UPDATE quote_acceptance_codes SET attempts = attempts + 1 WHERE org_id = $1 AND id = $2', [
    link.orgId,
    row.id,
  ]);
  return hashesEqual(row.code_hash, codeHash(link.id, code)) ? null : new ApiError(422, 'That code is not correct');
}

/**
 * Transaction 2 (the accept transaction): re-check the code against the
 * locked row and consume it, so it can be used once. Throws 422 on any
 * mismatch — a concurrent accept that consumed it first lands here too.
 */
export async function verifyAcceptanceCodeOnClient(
  client: PoolClient,
  link: LiveQuoteLink,
  signerEmail: string,
  code: string,
): Promise<void> {
  const row = await lockNewestCodeOnClient(client, link, signerEmail);
  if (row === undefined) throw new ApiError(422, 'Request a new verification code');
  if (!hashesEqual(row.code_hash, codeHash(link.id, code))) throw new ApiError(422, 'That code is not correct');
  await client.query('UPDATE quote_acceptance_codes SET consumed_at = now() WHERE org_id = $1 AND id = $2', [
    link.orgId,
    row.id,
  ]);
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
  const required = await requiresEmailCode(link.orgId);
  if (required && input.signerEmail === null) {
    throw new ApiError(422, 'Enter your email to receive a verification code');
  }
  if (required && input.code === null) {
    throw new ApiError(422, 'Enter the verification code we emailed you');
  }
  // Verification applies when the org requires it, or when the signer chose to supply a code.
  const verify = required || input.code !== null;
  if (verify && input.signerEmail === null) {
    throw new ApiError(422, 'Enter your email to receive a verification code');
  }
  if (verify && input.signerEmail !== null && input.code !== null) {
    const email = input.signerEmail;
    const code = input.code;
    const failure = await withTransaction((client) => bumpAttemptOnClient(client, link, email, code));
    if (failure !== null) throw failure;
  }
  await quoteService.runQuoteWrite(async (client) => {
    if (verify && input.signerEmail !== null && input.code !== null) {
      await verifyAcceptanceCodeOnClient(client, link, input.signerEmail, input.code);
    }
    await quoteService.respondOnClient(client, link.orgId, link.quoteId, {
      response: 'ACCEPTED',
      channel: 'PUBLIC_LINK',
      linkId: link.id,
      signerName: input.signerName,
      signerEmail: input.signerEmail,
      signerEmailVerified: verify,
      termsAccepted: input.acceptTerms,
      declineReason: null,
      clientIp: from.ip,
      userAgent: from.userAgent,
      recordedBy: null,
      note: null,
      expectedContentSha256: input.contentSha256,
    });
  });
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
      signerEmailVerified: false,
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
