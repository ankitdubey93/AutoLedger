import type { RequestHandler } from 'express';
import * as publicQuoteService from '../../services/accounting/publicQuoteService.js';
import { publicAcceptQuoteSchema, publicDeclineQuoteSchema } from '../../schemas/accounting/quoteSchema.js';
import { getRequestContext } from '../../utils/requestContext.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireParam } from '../../utils/routeParam.js';

/**
 * Public quote-link adapters (Phase 41). No session: the token in the path
 * is the credential, and the service resolves the organization from it.
 * Zero SQL (rule 2). Every response is `no-store` — a bearer-token page must
 * never be cached between us and the recipient.
 */

/** The acceptance evidence's client side: Express's resolved IP and the User-Agent, already truncated. */
function responder(): publicQuoteService.ResponseClient {
  const ctx = getRequestContext();
  return { ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null };
}

/** GET /public/quotes/:token */
export const view: RequestHandler = async (req, res) => {
  const quote = await publicQuoteService.getPublicQuote(requireParam(req, 'token'));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, quote });
};

/** GET /public/quotes/:token/logo */
export const logo: RequestHandler = async (req, res) => {
  const { mimeType, byteSize, stream } = await publicQuoteService.openPublicQuoteLogo(requireParam(req, 'token'));
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(byteSize));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
};

/** POST /public/quotes/:token/accept */
export const accept: RequestHandler = async (req, res) => {
  const input = parseBody(publicAcceptQuoteSchema, req.body);
  const quote = await publicQuoteService.acceptPublicQuote(requireParam(req, 'token'), input, responder());
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, quote });
};

/** POST /public/quotes/:token/decline */
export const decline: RequestHandler = async (req, res) => {
  const { reason } = parseBody(publicDeclineQuoteSchema, req.body ?? {});
  const quote = await publicQuoteService.declinePublicQuote(requireParam(req, 'token'), reason, responder());
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, quote });
};
