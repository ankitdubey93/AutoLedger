import type { RequestHandler } from 'express';
import * as assumptionService from '../../services/fpa-engine/assumptionService.js';
import { upsertAssumptionSchema } from '../../schemas/fpa-engine/assumptionSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over assumptionService. Zero SQL (guardrails rule 2). */

/** GET /fpa-engine/scenarios/:id/assumptions */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const assumptions = await assumptionService.listAssumptions(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, assumptions, count: assumptions.length });
};

/** PUT /fpa-engine/scenarios/:id/assumptions/:accountId */
export const upsert: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(upsertAssumptionSchema, req.body);
  const assumption = await assumptionService.upsertAssumption(
    user.orgId,
    requireParam(req, 'id'),
    requireParam(req, 'accountId'),
    input,
  );
  res.json({ success: true, assumption });
};

/** DELETE /fpa-engine/scenarios/:id/assumptions/:accountId */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await assumptionService.deleteAssumption(user.orgId, requireParam(req, 'id'), requireParam(req, 'accountId'));
  res.json({ success: true });
};
