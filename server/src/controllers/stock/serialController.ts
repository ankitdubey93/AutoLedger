import type { RequestHandler } from 'express';
import * as serialService from '../../services/stock/serialService.js';
import { serialAttributesSchema, serialStatusSchema } from '../../schemas/stock/serialSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over serialService. Zero SQL (guardrails rule 2). */

/** POST /stock/serials/:id/status */
export const changeStatus: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(serialStatusSchema, req.body);
  const serial = await serialService.changeSerialStatus(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, serial });
};

/** PATCH /stock/serials/:id */
export const updateAttributes: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(serialAttributesSchema, req.body);
  const serial = await serialService.updateSerialAttributes(user.orgId, requireParam(req, 'id'), input.attributes);
  res.json({ success: true, serial });
};
