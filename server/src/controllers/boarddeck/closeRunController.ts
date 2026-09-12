import type { RequestHandler } from 'express';
import * as closeRunService from '../../services/boarddeck/closeRunService.js';
import { createCloseRunSchema } from '../../schemas/boarddeck/closeRunSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/** Thin adapters over closeRunService. Zero SQL (guardrails rule 2). */

/** GET /boarddeck/close-runs */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const closeRuns = await closeRunService.listRuns(user.orgId);
  res.json({ success: true, count: closeRuns.length, closeRuns });
};

/** GET /boarddeck/close-runs/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const closeRun = await closeRunService.getRunById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, closeRun });
};

/** POST /boarddeck/close-runs */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createCloseRunSchema, req.body);
  const closeRun = await closeRunService.createRun(user.orgId, user.id, input.fiscalPeriodId);
  res.status(201).json({ success: true, closeRun });
};

/** POST /boarddeck/close-runs/:id/rerun */
export const rerun: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const closeRun = await closeRunService.rerunChecks(user.orgId, user.id, requireParam(req, 'id'));
  res.json({ success: true, closeRun });
};

/** POST /boarddeck/close-runs/:id/close-period */
export const closePeriod: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const closeRun = await closeRunService.closePeriodFromRun(user.orgId, user.id, requireParam(req, 'id'));
  res.json({ success: true, closeRun });
};
