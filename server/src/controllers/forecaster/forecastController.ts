import type { RequestHandler } from 'express';
import * as forecastLineService from '../../services/forecaster/forecastLineService.js';
import * as forecastService from '../../services/forecaster/forecastService.js';
import {
  createForecastLineSchema,
  updateForecastLineSchema,
} from '../../schemas/forecaster/forecastLineSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over forecastLineService/forecastService. Zero SQL (guardrails rule 2). */

/** GET /forecaster/plans/:id/forecast-lines */
export const listLines: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const lines = await forecastLineService.listLines(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, lines, count: lines.length });
};

/** POST /forecaster/plans/:id/forecast-lines */
export const createLine: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createForecastLineSchema, req.body);
  const line = await forecastLineService.createLine(user.orgId, requireParam(req, 'id'), input);
  res.status(201).json({ success: true, line });
};

/** PATCH /forecaster/forecast-lines/:id */
export const updateLine: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateForecastLineSchema, req.body);
  const line = await forecastLineService.updateLine(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, line });
};

/** DELETE /forecaster/forecast-lines/:id */
export const removeLine: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await forecastLineService.deleteLine(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};

/** GET /forecaster/plans/:id/forecast */
export const getForecast: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const forecast = await forecastService.buildPlanForecast(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, forecast });
};
