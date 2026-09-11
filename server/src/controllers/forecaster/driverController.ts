import type { RequestHandler } from 'express';
import * as driverService from '../../services/forecaster/driverService.js';
import {
  createDriverSchema,
  setDriverValuesSchema,
  updateDriverSchema,
} from '../../schemas/forecaster/driverSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over driverService. Zero SQL (guardrails rule 2). */

/** GET /forecaster/plans/:id/drivers */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const drivers = await driverService.listDrivers(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, drivers, count: drivers.length });
};

/** POST /forecaster/plans/:id/drivers */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createDriverSchema, req.body);
  const driver = await driverService.createDriver(user.orgId, requireParam(req, 'id'), input);
  res.status(201).json({ success: true, driver });
};

/** PATCH /forecaster/drivers/:id */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateDriverSchema, req.body);
  const driver = await driverService.updateDriver(user.orgId, requireParam(req, 'id'), input);
  res.json({ success: true, driver });
};

/** DELETE /forecaster/drivers/:id */
export const remove: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await driverService.deleteDriver(user.orgId, requireParam(req, 'id'));
  res.json({ success: true });
};

/** GET /forecaster/drivers/:id/values */
export const listValues: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const values = await driverService.listDriverValues(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, values, count: values.length });
};

/** PUT /forecaster/drivers/:id/values */
export const setValues: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(setDriverValuesSchema, req.body);
  const values = await driverService.setDriverValues(user.orgId, requireParam(req, 'id'), input.values);
  res.json({ success: true, values, count: values.length });
};
