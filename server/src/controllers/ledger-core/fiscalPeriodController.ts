import type { Request, RequestHandler } from 'express';
import * as fiscalPeriodService from '../../services/ledger-core/fiscalPeriodService.js';
import { generatePeriodsSchema } from '../../schemas/ledger-core/fiscalPeriodSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';
import { requireParam } from '../../utils/routeParam.js';
import { optionalText } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { FISCAL_PERIOD_STATUSES, type FiscalPeriodStatus } from '../../types/ledger-core.js';

/** Thin adapters over fiscalPeriodService. Zero SQL (guardrails rule 2). */

function optionalStatus(req: Request): FiscalPeriodStatus | null {
  const raw = optionalText(req, 'status', 20);
  if (raw === null) return null;
  if (!(FISCAL_PERIOD_STATUSES as readonly string[]).includes(raw)) {
    throw new ApiError(400, 'status must be one of OPEN, CLOSED, LOCKED');
  }
  return raw as FiscalPeriodStatus;
}

/** GET /ledger-core/fiscal-periods */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const periods = await fiscalPeriodService.listPeriods(user.orgId, {
    fiscalYearLabel: optionalText(req, 'fiscalYear', 20),
    status: optionalStatus(req),
  });
  res.json({ success: true, count: periods.length, periods });
};

/** GET /ledger-core/fiscal-periods/:id */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const period = await fiscalPeriodService.getPeriodById(user.orgId, requireParam(req, 'id'));
  res.json({ success: true, period });
};

/** POST /ledger-core/fiscal-periods/generate */
export const generate: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(generatePeriodsSchema, req.body);
  const result = await fiscalPeriodService.generatePeriods(user.orgId, user.id, input.containingDate);
  res.status(result.created ? 201 : 200).json({
    success: true,
    fiscalYearLabel: result.fiscalYearLabel,
    created: result.created,
    count: result.periods.length,
    periods: result.periods,
  });
};

/** POST /ledger-core/fiscal-periods/:id/close */
export const close: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const period = await fiscalPeriodService.closePeriod(user.orgId, user.id, requireParam(req, 'id'));
  res.json({ success: true, period });
};

/** POST /ledger-core/fiscal-periods/:id/reopen */
export const reopen: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const period = await fiscalPeriodService.reopenPeriod(user.orgId, user.id, requireParam(req, 'id'));
  res.json({ success: true, period });
};

/** POST /ledger-core/fiscal-periods/:id/lock */
export const lock: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const period = await fiscalPeriodService.lockPeriod(user.orgId, user.id, requireParam(req, 'id'));
  res.json({ success: true, period });
};
