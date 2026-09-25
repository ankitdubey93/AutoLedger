import type { RequestHandler } from 'express';
import * as recurringService from '../../services/accounting/recurringService.js';
import { createRecurringScheduleSchema, listRecurringSchedulesQuerySchema } from '../../schemas/accounting/recurringScheduleSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';

/**
 * Thin adapters over recurringService. Zero SQL (guardrails rule 2).
 *
 * There is no DELETE — a schedule is ended with `POST /:id/end`,
 * never deleted. To change a schedule, end it and create a new one.
 */

/** GET /recurring-schedules */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const queryInput = parseBody(listRecurringSchedulesQuerySchema, req.query);
  const schedules = await recurringService.listSchedules(user.orgId, {
    kind: queryInput.kind ?? null,
    status: queryInput.status ?? null,
  });
  res.json({ success: true, count: schedules.length, schedules });
};

/** GET /recurring-schedules/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const schedule = await recurringService.getScheduleById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, schedule });
};

/** POST /recurring-schedules */
export const create: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(createRecurringScheduleSchema, req.body);
  const schedule = await recurringService.createSchedule(user.orgId, user.id, input);
  res.status(201).json({ success: true, schedule });
};

/** POST /recurring-schedules/:id/pause */
export const pause: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const schedule = await recurringService.transitionSchedule(user.orgId, requireParam(req, 'id'), 'PAUSED');
  res.json({ success: true, schedule });
};

/** POST /recurring-schedules/:id/resume */
export const resume: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const schedule = await recurringService.transitionSchedule(user.orgId, requireParam(req, 'id'), 'ACTIVE');
  res.json({ success: true, schedule });
};

/** POST /recurring-schedules/:id/end */
export const end: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const schedule = await recurringService.transitionSchedule(user.orgId, requireParam(req, 'id'), 'ENDED');
  res.json({ success: true, schedule });
};

/** POST /recurring-schedules/:id/run */
export const run: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const result = await recurringService.runDueOccurrences(user.orgId, requireParam(req, 'id'));
  const schedule = await recurringService.getScheduleById(user.orgId, requireParam(req, 'id'));
  res.json({
    success: true,
    generated: result.generated,
    lastError: result.lastError,
    schedule,
  });
};
