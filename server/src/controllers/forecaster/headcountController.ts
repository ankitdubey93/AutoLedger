import type { RequestHandler } from 'express';
import * as headcountService from '../../services/forecaster/headcountService.js';
import {
  createHeadcountRoleSchema,
  updateHeadcountRoleSchema,
} from '../../schemas/forecaster/headcountSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over headcountService. Zero SQL (guardrails rule 2). */

/** GET /forecaster/plans/:id/headcount */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const roles = await headcountService.listRoles(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, roles, count: roles.length });
};

/** POST /forecaster/plans/:id/headcount */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createHeadcountRoleSchema, req.body);
  const role = await headcountService.createRole(user.orgId, requireParam(req, 'id'), input);
  res.status(201).json({ success: true, role });
};

/** PATCH /forecaster/headcount/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateHeadcountRoleSchema, req.body);
  const role = await headcountService.updateRole(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, role });
};

/** DELETE /forecaster/headcount/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await headcountService.deleteRole(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};
