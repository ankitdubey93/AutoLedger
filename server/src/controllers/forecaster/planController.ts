import type { RequestHandler } from 'express';
import * as planService from '../../services/forecaster/planService.js';
import { createPlanSchema, updatePlanSchema } from '../../schemas/forecaster/planSchema.js';
import { isForecasterPlanStatus } from '../../types/forecaster.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalText, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';

/** Thin adapters over planService. Zero SQL (guardrails rule 2). */

/** GET /forecaster/plans */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const statusRaw = optionalText(req, 'status', 20);
  if (statusRaw !== null && !isForecasterPlanStatus(statusRaw)) {
    throw new ApiError(400, 'status must be one of DRAFT, ACTIVE, ARCHIVED');
  }

  const { plans, totalCount } = await planService.listPlans(user.orgId, {
    page,
    limit,
    status: statusRaw,
  });

  res.json({
    success: true,
    plans,
    count: plans.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
  });
};

/** GET /forecaster/plans/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const plan = await planService.getPlanById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, plan });
};

/** POST /forecaster/plans */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createPlanSchema, req.body);
  const plan = await planService.createPlan(user.orgId, user.id, input);
  res.status(201).json({ success: true, plan });
};

/** PATCH /forecaster/plans/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updatePlanSchema, req.body);
  const plan = await planService.updatePlan(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, plan });
};

/** DELETE /forecaster/plans/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await planService.deletePlan(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};

/** POST /forecaster/plans/:id/roll */
export const roll: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const plan = await planService.rollPlan(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, plan });
};
