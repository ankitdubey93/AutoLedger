import type { Request, RequestHandler } from 'express';
import * as reportService from '../../services/accounting/reportService.js';
import * as dashboardService from '../../services/accounting/dashboardService.js';
import * as agingService from '../../services/accounting/agingService.js';
import * as fxRevaluationService from '../../services/accounting/fxRevaluationService.js';
import * as accountTransactionsService from '../../services/accounting/accountTransactionsService.js';
import * as taxSummaryService from '../../services/accounting/taxSummaryService.js';
import * as salesPurchasesReportService from '../../services/accounting/salesPurchasesReportService.js';
import * as cashFlowService from '../../services/accounting/cashFlowService.js';
import { requireUser } from '../../utils/requireUser.js';
import { optionalCsvList, optionalIsoDate, optionalUuid } from '../../utils/queryParam.js';
import { ApiError } from '../../utils/apiError.js';
import { COMPARISON_MODES } from '../../utils/comparisonPeriods.js';
import {
  ACCOUNT_TRANSACTION_COLUMNS,
  ACCOUNT_TRANSACTION_GROUPINGS,
  ACCOUNT_TRANSACTION_MODES,
  DEFAULT_ACCOUNT_TRANSACTION_COLUMNS,
  type AccountTransactionColumn,
  type SalesPurchasesReportKind,
} from '../../types/accounting.js';
import {
  accountTransactionsTable,
  agingTable,
  balanceSheetTable,
  cashFlowTable,
  profitAndLossComparisonTable,
  profitAndLossTable,
  salesPurchasesTable,
  taxSummaryTable,
  trialBalanceTable,
} from '../../services/accounting/reportTables.js';
import { readReportFormat, sendReportFile } from './reportExport.js';

/** Phase 45 — a UUID as text, for the `accountIds` list. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One of `choices`, or `fallback` when absent; anything else is a 400 with `message`. */
function readChoice<T extends string>(
  req: Request,
  name: string,
  choices: readonly T[],
  fallback: T,
  message: string,
): T {
  const value = req.query[name];
  if (value === undefined) return fallback;
  const found = typeof value === 'string' ? choices.find((choice) => choice === value) : undefined;
  if (found === undefined) throw new ApiError(400, message);
  return found;
}

/** `columns` in request order, each validated against the constant list; absent → the default. */
function readAccountTransactionColumns(req: Request): readonly AccountTransactionColumn[] {
  const names = optionalCsvList(req, 'columns', /^[A-Za-z]{1,20}$/, 14, 'columns must be a comma-separated list');
  if (names === null) return DEFAULT_ACCOUNT_TRANSACTION_COLUMNS;
  return names.map((name) => {
    const column = ACCOUNT_TRANSACTION_COLUMNS.find((candidate) => candidate === name);
    if (column === undefined) throw new ApiError(400, `Unknown column "${name}"`);
    return column;
  });
}

/** Thin adapters over reportService. Zero SQL (guardrails rule 2). */

/** GET /reports/trial-balance?asOf=YYYY-MM-DD */
export const trialBalance: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');
  const format = readReportFormat(req);

  const report = await reportService.trialBalance(user.orgId, asOf);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, trialBalanceTable(ctx, report), format);
    return;
  }

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

/** GET /reports/profit-and-loss?from=YYYY-MM-DD&to=YYYY-MM-DD */
export const profitAndLoss: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const from = optionalIsoDate(req, 'from');
  const to = optionalIsoDate(req, 'to');
  const format = readReportFormat(req);

  const report = await reportService.profitAndLoss(user.orgId, from, to);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, profitAndLossTable(ctx, report), format);
    return;
  }
  res.json({ success: true, ...report });
};

/** GET /reports/profit-and-loss/comparison?from=&to=&compare=previousPeriod|samePeriodLastYear&periods=1..11 */
export const profitAndLossComparison: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const from = optionalIsoDate(req, 'from');
  const to = optionalIsoDate(req, 'to');
  const mode = readChoice(
    req,
    'compare',
    COMPARISON_MODES,
    'previousPeriod',
    'compare must be previousPeriod or samePeriodLastYear',
  );
  const rawPeriods = req.query.periods;
  let periods = 1;
  if (rawPeriods !== undefined) {
    if (typeof rawPeriods !== 'string' || !/^\d+$/.test(rawPeriods)) {
      throw new ApiError(400, 'periods must be between 1 and 11');
    }
    periods = Number(rawPeriods);
    if (periods < 1 || periods > 11) throw new ApiError(400, 'periods must be between 1 and 11');
  }
  const format = readReportFormat(req);

  const report = await reportService.profitAndLossComparison(user.orgId, from, to, mode, periods);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, profitAndLossComparisonTable(ctx, report), format);
    return;
  }
  res.json({ success: true, ...report });
};

/** GET /reports/balance-sheet?asOf=YYYY-MM-DD */
export const balanceSheet: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');
  const format = readReportFormat(req);

  const report = await reportService.balanceSheet(user.orgId, asOf);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, balanceSheetTable(ctx, report), format);
    return;
  }
  res.json({ success: true, ...report });
};

/** GET /reports/cash-flow?from=YYYY-MM-DD&to=YYYY-MM-DD */
export const cashFlow: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const from = optionalIsoDate(req, 'from');
  const to = optionalIsoDate(req, 'to');
  const format = readReportFormat(req);

  const report = await cashFlowService.cashFlowStatement(user.orgId, from, to);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, cashFlowTable(ctx, report), format);
    return;
  }
  res.json({ success: true, ...report });
};

/** GET /reports/dashboard?asOf=YYYY-MM-DD */
export const dashboard: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');

  const summary = await dashboardService.dashboardSummary(user.orgId, asOf);
  res.json({ success: true, ...summary });
};

/** GET /reports/ar-aging?asOf=YYYY-MM-DD */
export const arAging: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');
  const format = readReportFormat(req);

  const report = await agingService.arAging(user.orgId, asOf);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, agingTable(ctx, report), format);
    return;
  }
  res.json({ success: true, ...report });
};

/** GET /reports/ap-aging?asOf=YYYY-MM-DD */
export const apAging: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf');
  const format = readReportFormat(req);

  const report = await agingService.apAging(user.orgId, asOf);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, agingTable(ctx, report), format);
    return;
  }
  res.json({ success: true, ...report });
};

/** GET /reports/tax-summary?from=YYYY-MM-DD&to=YYYY-MM-DD */
export const taxSummary: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const from = optionalIsoDate(req, 'from');
  const to = optionalIsoDate(req, 'to');
  if (from === null || to === null) throw new ApiError(400, 'from and to are required');
  const format = readReportFormat(req);

  const report = await taxSummaryService.taxSummary(user.orgId, from, to);
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, taxSummaryTable(ctx, report), format);
    return;
  }
  res.json({ success: true, ...report });
};

/**
 * GET /reports/sales-by-customer|purchases-by-vendor|sales-by-item|purchases-by-item
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD&compare=previousPeriod|samePeriodLastYear&format=
 * Phase 45 — one handler per kind. The format is read before the service call.
 */
export function salesPurchases(kind: SalesPurchasesReportKind): RequestHandler {
  return async (req, res) => {
    const user = requireUser(req);
    const from = optionalIsoDate(req, 'from');
    const to = optionalIsoDate(req, 'to');
    if (from === null || to === null) throw new ApiError(400, 'from and to are required');
    const compare =
      req.query.compare === undefined
        ? null
        : readChoice(
            req,
            'compare',
            COMPARISON_MODES,
            'previousPeriod',
            'compare must be previousPeriod or samePeriodLastYear',
          );
    const format = readReportFormat(req);

    const report = await salesPurchasesReportService.salesPurchasesReport(user.orgId, kind, from, to, compare);
    if (format !== null) {
      const ctx = await reportService.loadReportContext(user.orgId);
      await sendReportFile(res, salesPurchasesTable(ctx, report), format);
      return;
    }
    res.json({ success: true, ...report });
  };
}

/** GET /reports/bank-reconciliation?accountId=<uuid>&asOf=YYYY-MM-DD */
export const bankReconciliation: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const accountId = optionalUuid(req, 'accountId');
  if (accountId === null) throw new ApiError(400, 'accountId is required');
  const asOf = optionalIsoDate(req, 'asOf') ?? new Date().toISOString().slice(0, 10);

  const report = await reportService.bankReconciliation(user.orgId, accountId, asOf);
  res.json({ success: true, ...report });
};

/** GET /reports/fx-exposure?asOf=YYYY-MM-DD */
export const fxExposure: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const asOf = optionalIsoDate(req, 'asOf') ?? new Date().toISOString().slice(0, 10);

  const report = await fxRevaluationService.computeExposure(user.orgId, asOf);
  res.json({ success: true, exposure: report });
};

/**
 * GET /reports/account-transactions?accountIds=&from=&to=&sourceTypes=&groupBy=&mode=&columns=&format=
 * Phase 45 — the format is read before the service call, so a bad one fails
 * with 400 without computing the report.
 */
export const accountTransactions: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const accountIds = optionalCsvList(
    req,
    'accountIds',
    UUID_RE,
    200,
    'accountIds must be a comma-separated list of ids',
  );
  const from = optionalIsoDate(req, 'from');
  const to = optionalIsoDate(req, 'to');
  if (from === null || to === null) throw new ApiError(400, 'from and to are required');
  const sourceTypes = optionalCsvList(
    req,
    'sourceTypes',
    /^[a-z_]{1,40}$/,
    20,
    'sourceTypes must be a comma-separated list of source types',
  );
  const groupBy = readChoice(
    req,
    'groupBy',
    ACCOUNT_TRANSACTION_GROUPINGS,
    'account',
    'groupBy must be one of account, month, sourceType, contact, none',
  );
  const mode = readChoice(req, 'mode', ACCOUNT_TRANSACTION_MODES, 'detail', 'mode must be detail or summary');
  const columns = readAccountTransactionColumns(req);
  const format = readReportFormat(req);

  const report = await accountTransactionsService.accountTransactions(user.orgId, {
    accountIds,
    from,
    to,
    sourceTypes,
    groupBy,
    mode,
  });
  if (format !== null) {
    const ctx = await reportService.loadReportContext(user.orgId);
    await sendReportFile(res, accountTransactionsTable(ctx, report, columns), format);
    return;
  }
  res.json({ success: true, ...report });
};
