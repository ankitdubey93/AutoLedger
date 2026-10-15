import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { requireUser } from '../../utils/requireUser.js';
import { readPagination } from '../../utils/queryParam.js';
import * as inboundMailService from '../../services/integrations/inboundMailService.js';
import { parseBatch } from '../../services/integrations/brevoInbound.js';

/** GET /integrations/inbound-mail — this organization's address, created on first read. */
export const getAddress: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await inboundMailService.getOrCreateAddress(user.orgId, user.id);
  res.json({ success: true, ...result });
};

/** POST /integrations/inbound-mail/rotate — the current address stops working. */
export const rotate: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await inboundMailService.rotateAddress(user.orgId, user.id);
  res.json({ success: true, ...result });
};

/** GET /integrations/inbound-mail/messages */
export const listMessages: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);
  const result = await inboundMailService.listMessages(user.orgId, page, limit);
  res.json({ success: true, ...result });
};

/** Equal-length buffers only: timingSafeEqual throws otherwise, and a length mismatch is a plain miss. */
function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /public/inbound-mail/brevo/:secret — Brevo's inbound-parsing webhook.
 * Unauthenticated; the path secret is the credential. Feature off or a wrong
 * secret is the same 404 (no oracle). After a valid secret the answer is 200
 * even if no recipient matched an address, so Brevo does not retry.
 */
export const brevoWebhook: RequestHandler = async (req, res) => {
  if (env.INBOUND_MAIL !== 'brevo') throw new ApiError(404, 'Not found');
  const secret = typeof req.params.secret === 'string' ? req.params.secret : '';
  if (!secretMatches(secret, env.INBOUND_MAIL_WEBHOOK_SECRET)) throw new ApiError(404, 'Not found');
  await inboundMailService.recordInboundBatch(parseBatch(req.body));
  res.json({ success: true });
};
