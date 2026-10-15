import type { PaymentTermRule } from '../types/accounting.js';

/**
 * Phase 43a — due-date arithmetic for payment terms. Pure, UTC only: every
 * calendar operation goes through Date.UTC / getUTC*, never local-time methods.
 * `client/src/utils/dueDate.ts` is an identical copy, kept in parity by the
 * shared fixture `client/src/__tests__/fixtures/dueDateCases.json`.
 *
 * `documentDate` and the result are 'YYYY-MM-DD'.
 */
export function computeDueDate(rule: PaymentTermRule, n: number, documentDate: string): string {
  const [year = 1970, month = 1, day = 1] = documentDate.split('-').map(Number);
  const m = month - 1; // 0-based, as Date.UTC expects

  switch (rule) {
    case 'DAYS_AFTER_DATE':
      return isoOf(year, m, day + n);
    case 'DAYS_AFTER_MONTH_END':
      return isoOf(year, m, daysInMonth(year, m) + n);
    case 'DAY_OF_NEXT_MONTH':
      return isoOf(year, m + 1, Math.min(n, daysInMonth(year, m + 1)));
    case 'DAY_OF_CURRENT_MONTH': {
      const thisMonth = isoOf(year, m, Math.min(n, daysInMonth(year, m)));
      if (thisMonth >= documentDate) return thisMonth;
      return isoOf(year, m + 1, Math.min(n, daysInMonth(year, m + 1)));
    }
  }
}

/** `monthIndex` may overflow (12 → January of the next year); Date.UTC normalises it. */
function isoOf(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
