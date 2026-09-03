import type { RequestHandler } from 'express';
import * as reportService from '../../services/ledger-core/reportService.js';
import * as dashboardService from '../../services/ledger-core/dashboardService.js';
import { requireUser } from '../../utils/requireUser.js';
import { ApiError } from '../../utils/apiError.js';

/** Thin adapters over reportService. Zero SQL (guardrails rule 2). */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /ledger-core/reports/trial-balance?asOf=YYYY-MM-DD */
export const trialBalance: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  const raw = req.query.asOf;
  let asOf: string | null = null;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !ISO_DATE.test(raw)) {
      throw new ApiError(400, 'asOf must be a date in YYYY-MM-DD format');
    }
    asOf = raw;
  }

  const report = await reportService.trialBalance(user.orgId, asOf);

  res.json({
    success: true,
    asOf: report.asOf,
    isBalanced: report.isBalanced,
    totalDebitCents: report.totalDebitCents,
    totalCreditCents: report.totalCreditCents,
    count: report.rows.length,
    rows: report.rows,
  });
};

/** GET /ledger-core/reports/dashboard?asOf=YYYY-MM-DD */
export const dashboard: RequestHandler = async (req, res) => {
  const user = requireUser(req);

  const raw = req.query.asOf;
  let asOf: string | null = null;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !ISO_DATE.test(raw)) {
      throw new ApiError(400, 'asOf must be a date in YYYY-MM-DD format');
    }
    asOf = raw;
  }

  const summary = await dashboardService.dashboardSummary(user.orgId, asOf);
  res.json({ success: true, ...summary });
};
