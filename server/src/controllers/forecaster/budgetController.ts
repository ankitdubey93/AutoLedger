import type { RequestHandler } from 'express';
import * as budgetService from '../../services/forecaster/budgetService.js';
import * as varianceService from '../../services/forecaster/varianceService.js';
import {
  createBudgetLineSchema,
  createBudgetVersionSchema,
  updateBudgetLineSchema,
} from '../../schemas/forecaster/budgetSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalIsoDate } from '../../utils/queryParam.js';

/** Thin adapters over budgetService/varianceService. Zero SQL (guardrails rule 2). */

/** GET /forecaster/plans/:id/budget-versions */
export const listVersions: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const versions = await budgetService.listVersions(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, versions, count: versions.length });
};

/** POST /forecaster/plans/:id/budget-versions */
export const createVersion: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createBudgetVersionSchema, req.body);
  const version = await budgetService.createVersion(user.orgId, requireParam(req, 'id'), user.id, input);
  res.status(201).json({ success: true, version });
};

/** GET /forecaster/budget-versions/:id */
export const getVersion: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const version = await budgetService.getVersionById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, version });
};

/** DELETE /forecaster/budget-versions/:id */
export const removeVersion: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await budgetService.deleteVersion(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};

/** POST /forecaster/budget-versions/:id/compile */
export const compileVersion: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const version = await budgetService.compileVersion(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, version });
};

/** POST /forecaster/budget-versions/:id/approve */
export const approveVersion: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const version = await budgetService.approveVersion(user.orgId, requireParam(req, 'id'), user.id);
  res.json({ success: true, version });
};

/** POST /forecaster/budget-versions/:id/lines */
export const addLine: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createBudgetLineSchema, req.body);
  const line = await budgetService.addLine(user.orgId, requireParam(req, 'id'), input);
  res.status(201).json({ success: true, line });
};

/** PATCH /forecaster/budget-lines/:id */
export const updateLine: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateBudgetLineSchema, req.body);
  const line = await budgetService.updateLine(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, line });
};

/** DELETE /forecaster/budget-lines/:id */
export const removeLine: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await budgetService.deleteLine(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};

/** GET /forecaster/plans/:id/variance */
export const getVariance: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const from = optionalIsoDate(req, 'from');
  const to = optionalIsoDate(req, 'to');
  const variance = await varianceService.planVariance(user.orgId, requireParam(req, 'id'), from, to);
  res.json({ success: true, variance });
};
