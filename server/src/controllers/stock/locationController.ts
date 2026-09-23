import type { RequestHandler } from 'express';
import * as locationService from '../../services/stock/locationService.js';
import { createLocationSchema, updateLocationSchema } from '../../schemas/stock/locationSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over locationService. Zero SQL (guardrails rule 2). */

/** GET /stock/locations */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const locations = await locationService.listLocations(user.orgId, req.query.includeInactive === 'true');
  res.json({ success: true, count: locations.length, locations });
};

/** POST /stock/locations */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createLocationSchema, req.body);
  const location = await locationService.createLocation(user.orgId, user.id, input);
  res.status(201).json({ success: true, location });
};

/** PATCH /stock/locations/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateLocationSchema, req.body);
  const location = await locationService.updateLocation(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, location });
};
