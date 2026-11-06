import type { RequestHandler } from 'express';
import * as invoiceSendService from '../../services/accounting/invoiceSendService.js';
import { sendInvoiceSchema } from '../../schemas/accounting/invoiceSendSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/**
 * Thin adapters over invoiceSendService (Phase 48). Zero SQL (guardrails rule 2);
 * the org always comes from the verified token (rule 1).
 */

/** POST /invoices/:id/send */
export const send: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(sendInvoiceSchema, req.body ?? {});
  const result = await invoiceSendService.sendInvoice(user.orgId, user.id, requireParam(req, 'id'), {
    toEmail: input.toEmail,
    message: input.message,
  });
  res.status(201).json({ success: true, send: result });
};

/** GET /invoices/:id/sends */
export const listSends: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const sends = await invoiceSendService.listInvoiceSends(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, sends });
};

/** POST /invoices/:id/sends/:sendId/revoke */
export const revokeSend: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const send = await invoiceSendService.revokeInvoiceSend(
    user.orgId,
    requireParam(req, 'id'),
    requireParam(req, 'sendId'),
  );
  res.json({ success: true, send });
};
