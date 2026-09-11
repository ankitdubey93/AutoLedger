import type { RequestHandler } from 'express';
import * as modelService from '../../services/fpa-engine/modelService.js';
import * as forecastService from '../../services/fpa-engine/forecastService.js';
import {
  createModelSchema,
  createScenarioSchema,
  updateModelSchema,
  updateScenarioSchema,
} from '../../schemas/fpa-engine/modelSchema.js';
import { isFpaModelStatus } from '../../types/fpa-engine.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalText, readPagination } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';

/** Thin adapters over modelService. Zero SQL (guardrails rule 2). */

/** GET /fpa-engine/models */
export const listModels: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { page, limit } = readPagination(req.query);

  const statusRaw = optionalText(req, 'status', 20);
  if (statusRaw !== null && !isFpaModelStatus(statusRaw)) {
    throw new ApiError(400, 'status must be one of DRAFT, ACTIVE, ARCHIVED');
  }

  const { models, totalCount } = await modelService.listModels(user.orgId, {
    page,
    limit,
    status: statusRaw,
  });

  res.json({
    success: true,
    models,
    count: models.length,
    totalCount,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
  });
};

/** GET /fpa-engine/models/:id */
export const getModel: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const model = await modelService.getModelById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, model });
};

/** POST /fpa-engine/models */
export const createModel: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createModelSchema, req.body);
  const model = await modelService.createModel(user.orgId, user.id, input);
  res.status(201).json({ success: true, model });
};

/** PATCH /fpa-engine/models/:id */
export const updateModel: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateModelSchema, req.body);
  const model = await modelService.updateModel(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, model });
};

/** DELETE /fpa-engine/models/:id */
export const deleteModel: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await modelService.deleteModel(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};

/** GET /fpa-engine/models/:id/scenarios */
export const listScenarios: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const scenarios = await modelService.listScenarios(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, scenarios, count: scenarios.length });
};

/** POST /fpa-engine/models/:id/scenarios */
export const createScenario: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createScenarioSchema, req.body);
  const scenario = await modelService.createScenario(user.orgId, requireParam(req, 'id'), input);
  res.status(201).json({ success: true, scenario });
};

/** PATCH /fpa-engine/scenarios/:id */
export const updateScenario: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateScenarioSchema, req.body);
  const scenario = await modelService.updateScenario(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, scenario });
};

/** DELETE /fpa-engine/scenarios/:id */
export const deleteScenario: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await modelService.deleteScenario(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};

/** GET /fpa-engine/scenarios/:id/projection */
export const projection: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await forecastService.buildProjection(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, ...result });
};

/** GET /fpa-engine/models/:id/comparison */
export const comparison: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await forecastService.compareScenarios(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, ...result });
};
