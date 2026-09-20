import type { RequestHandler } from 'express';
import * as paymentTermService from '../../services/ledger-core/paymentTermService.js';
import { createPaymentTermSchema, updatePaymentTermSchema } from '../../schemas/ledger-core/paymentTermSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/**
 * Thin adapters over paymentTermService. Zero SQL (guardrails rule 2).
 *
 * There is no GET `/:id` and no `remove` export — a term is read only as
 * part of the list, and retired with `isActive: false` through `update`,
 * never deleted.
 */

/** GET /ledger-core/payment-terms */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const paymentTerms = await paymentTermService.listPaymentTerms(user.orgId, {
    includeInactive: req.query.includeInactive === 'true',
  });
  res.json({ success: true, count: paymentTerms.length, paymentTerms });
};

/** POST /ledger-core/payment-terms */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createPaymentTermSchema, req.body);
  const paymentTerm = await paymentTermService.createPaymentTerm(user.orgId, user.id, input);
  res.status(201).json({ success: true, paymentTerm });
};

/** PATCH /ledger-core/payment-terms/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updatePaymentTermSchema, req.body);
  const paymentTerm = await paymentTermService.updatePaymentTerm(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, paymentTerm });
};
