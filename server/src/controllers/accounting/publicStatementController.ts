import type { RequestHandler } from 'express';
import * as publicStatementService from '../../services/accounting/publicStatementService.js';
import * as onlinePaymentService from '../../services/accounting/onlinePaymentService.js';
import { startOnlinePaymentSchema } from '../../schemas/accounting/statementEmailSchema.js';
import { ApiError } from '../../utils/apiError.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireParam } from '../../utils/routeParam.js';

/**
 * Public statement-link adapters (Phase 39b). No session: the token in the
 * path is the credential, and the service resolves the organization from it.
 * Zero SQL (rule 2).
 */

/** GET /public/statements/:token */
export const view: RequestHandler = async (req, res) => {
  const statement = await publicStatementService.getPublicStatement(requireParam(req, 'token'));
  // A bearer-token page: never cache it anywhere between us and the customer.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, ...statement });
};

/** GET /public/statements/:token/logo */
export const logo: RequestHandler = async (req, res) => {
  const { mimeType, byteSize, stream } = await publicStatementService.openPublicLogo(requireParam(req, 'token'));
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(byteSize));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
};

/** POST /public/statements/:token/payments — start paying the chosen invoices (39c). */
export const startPayment: RequestHandler = async (req, res) => {
  const input = parseBody(startOnlinePaymentSchema, req.body);
  const started = await onlinePaymentService.startPayment(requireParam(req, 'token'), input.invoiceIds);
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ success: true, payment: started });
};

/** POST /public/statements/:token/payments/:intentId/confirm — the browser reports Stripe said yes (39c). */
export const confirmPayment: RequestHandler = async (req, res) => {
  const result = await onlinePaymentService.confirmFromLink(requireParam(req, 'token'), requireParam(req, 'intentId'));
  res.json({ success: true, ...result });
};

/** POST /public/stripe/webhook — raw body; the Stripe-Signature header is the credential (39c). */
export const stripeWebhook: RequestHandler = async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new ApiError(400, 'Webhook body must be raw JSON');
  await onlinePaymentService.handleWebhook(req.body, req.get('stripe-signature'));
  res.json({ received: true });
};
