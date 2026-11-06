import type { RequestHandler } from 'express';
import * as publicInvoiceService from '../../services/accounting/publicInvoiceService.js';
import * as onlinePaymentService from '../../services/accounting/onlinePaymentService.js';
import { requireParam } from '../../utils/routeParam.js';

/**
 * Public invoice-link adapters (Phase 48, Slice D). No session: the token in
 * the path is the credential, and the service resolves the organization from
 * it. Zero SQL (rule 2).
 */

/** GET /public/invoices/:token */
export const view: RequestHandler = async (req, res) => {
  const invoice = await publicInvoiceService.getPublicInvoice(requireParam(req, 'token'));
  // A bearer-token page: never cache it anywhere between us and the customer.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, ...invoice });
};

/** GET /public/invoices/:token/logo */
export const logo: RequestHandler = async (req, res) => {
  const { mimeType, byteSize, stream } = await publicInvoiceService.openPublicInvoiceLogo(requireParam(req, 'token'));
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(byteSize));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
};

/** GET /public/invoices/:token/pdf */
export const pdf: RequestHandler = async (req, res) => {
  const file = await publicInvoiceService.getPublicInvoicePdf(requireParam(req, 'token'));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Content-Length', String(file.pdf.length));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.pdf);
};

/**
 * POST /public/invoices/:token/payments — start paying. The browser sends no
 * body: the server prices the invoice's whole outstanding amount itself.
 */
export const startPayment: RequestHandler = async (req, res) => {
  const payment = await onlinePaymentService.startInvoicePayment(requireParam(req, 'token'));
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ success: true, payment });
};

/** POST /public/invoices/:token/payments/:intentId/confirm — the browser reports Stripe said yes. */
export const confirmPayment: RequestHandler = async (req, res) => {
  const result = await onlinePaymentService.confirmFromInvoiceLink(
    requireParam(req, 'token'),
    requireParam(req, 'intentId'),
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, ...result });
};
