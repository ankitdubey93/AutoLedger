import * as reportService from '../ledger-core/reportService.js';
import * as organizationService from '../organizationService.js';
import { buildCohortMatrix } from '../../utils/uniteconCohort.js';
import { monthBounds } from '../../utils/fiscalYear.js';
import { ApiError } from '../../utils/apiError.js';
import type { CohortMatrix } from '../../types/unitecon.js';

/**
 * UnitEcon (Phase 14) — cohort retention. This file contains ZERO SQL. Its
 * only route into LedgerCore is `reportService.customerRevenueByMonth`
 * (guardrails rule 16), the same boundary `forecaster/varianceService.ts`
 * documents for its own reads.
 */

const MAX_WINDOW_MONTHS = 60;

export interface CohortResponse {
  baseCurrency: string;
  from: string; // 'YYYY-MM-01'
  to: string; // 'YYYY-MM-01' - the last month of the window
  matrix: CohortMatrix;
}

/** `horizonMonths`-style month-start strings from `from` through `to`
 *  inclusive. Built with `Date.UTC`, never `new Date(iso)`. */
function monthsBetween(from: string, to: string): string[] {
  const [fromYearStr, fromMonthStr] = from.split('-');
  const fromYear = Number(fromYearStr);
  const fromMonth = Number(fromMonthStr); // 1-12

  const months: string[] = [];
  for (let k = 0; ; k++) {
    const d = new Date(Date.UTC(fromYear, fromMonth - 1 + k, 1));
    const monthStr = d.toISOString().slice(0, 10);
    if (monthStr > to) break;
    months.push(monthStr);
    if (months.length > MAX_WINDOW_MONTHS) break;
  }
  return months;
}

export async function cohortMatrix(orgId: string, from: string, to: string): Promise<CohortResponse> {
  if (from > to) throw new ApiError(422, 'from must not be after to');

  const months = monthsBetween(from, to);
  if (months.length > MAX_WINDOW_MONTHS) {
    throw new ApiError(422, 'The cohort window may span at most 60 months');
  }

  const org = await organizationService.getById(orgId);

  // All-time history, not only the display window - a customer's cohort
  // month must be found even when it precedes `from` (decision D12).
  const facts = await reportService.customerRevenueByMonth(orgId, '1900-01-01', monthBounds(to).endDate);

  const matrix = buildCohortMatrix(facts, months);

  return { baseCurrency: org.baseCurrency, from, to, matrix };
}
