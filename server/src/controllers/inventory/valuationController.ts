import type { RequestHandler } from 'express';
import * as valuationService from '../../services/inventory/valuationService.js';
import { trueUpSchema } from '../../schemas/inventory/valuationSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { optionalIsoDate } from '../../utils/queryParam.js';
import { requireUser } from '../../utils/requireUser.js';

/** Thin adapters over valuationService. Zero SQL (guardrails rule 2). */

/** GET /inventory/valuation */
export const get: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');
  const valuation = await valuationService.getValuation(user.orgId, asOf);
  res.json({ success: true, valuation });
};

/** POST /inventory/reconcile/true-up */
export const trueUp: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(trueUpSchema, req.body);
  const trueUp = await valuationService.trueUp(user.orgId, user.id, input);
  res.status(201).json({ success: true, trueUp });
};

/** POST /inventory/reconcile/reclass */
export const reclass: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await valuationService.reclassMisplaced(user.orgId, user.id);
  res.json({ success: true, postingCount: result.postingCount });
};

/** POST /inventory/items/link-all */
export const linkAll: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await valuationService.linkAll(user.orgId, user.id);
  res.json({ success: true, result });
};
