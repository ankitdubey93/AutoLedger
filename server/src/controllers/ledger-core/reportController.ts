import type { RequestHandler } from 'express';
import * as reportService from '../../services/ledger-core/reportService.js';
import * as dashboardService from '../../services/ledger-core/dashboardService.js';
import * as agingService from '../../services/ledger-core/agingService.js';
import { requireUser } from '../../utils/requireUser.js';
import { optionalIsoDate, optionalUuid } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';

/** Thin adapters over reportService. Zero SQL (guardrails rule 2). */

/** GET /ledger-core/reports/trial-balance?asOf=YYYY-MM-DD */
export const trialBalance: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');

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

/** GET /ledger-core/reports/profit-and-loss?from=YYYY-MM-DD&to=YYYY-MM-DD */
export const profitAndLoss: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const from = optionalIsoDate(req, 'from');
  const to = optionalIsoDate(req, 'to');

  const report = await reportService.profitAndLoss(user.orgId, from, to);
  res.json({ success: true, ...report });
};

/** GET /ledger-core/reports/balance-sheet?asOf=YYYY-MM-DD */
export const balanceSheet: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');

  const report = await reportService.balanceSheet(user.orgId, asOf);
  res.json({ success: true, ...report });
};

/** GET /ledger-core/reports/dashboard?asOf=YYYY-MM-DD */
export const dashboard: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');

  const summary = await dashboardService.dashboardSummary(user.orgId, asOf);
  res.json({ success: true, ...summary });
};

/** GET /ledger-core/reports/ar-aging?asOf=YYYY-MM-DD */
export const arAging: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');

  const report = await agingService.arAging(user.orgId, asOf);
  res.json({ success: true, ...report });
};

/** GET /ledger-core/reports/ap-aging?asOf=YYYY-MM-DD */
export const apAging: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');

  const report = await agingService.apAging(user.orgId, asOf);
  res.json({ success: true, ...report });
};

/** GET /ledger-core/reports/bank-reconciliation?accountId=<uuid>&asOf=YYYY-MM-DD */
export const bankReconciliation: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const accountId = optionalUuid(req, 'accountId');
  if (accountId === null) throw new ApiError(400, 'accountId is required');
  const asOf = optionalIsoDate(req, 'asOf') ?? new Date().toISOString().slice(0, 10);

  const report = await reportService.bankReconciliation(user.orgId, accountId, asOf);
  res.json({ success: true, ...report });
};
