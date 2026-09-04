/**
 * Fiscal-year and month-window arithmetic. Pure, no DB import — every function
 * here takes and returns `'YYYY-MM-DD'` strings.
 *
 * Never `new Date(isoString)` on a bare date string: that parses at local
 * midnight, and at UTC+05:30 (or any positive offset) it silently shifts the
 * calendar date back a day. This is the exact bug `db/connect.ts`'s `DATE`
 * type parser already exists to prevent one column over — see
 * study/typescript/branded-types-for-money.md's sibling concern. Every date
 * here is parsed by splitting on `-` and constructed with `Date.UTC`.
 */

interface IsoDateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

function parseIsoDate(iso: string): IsoDateParts {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Not a YYYY-MM-DD date: "${iso}"`);
  }
  return { year, month, day };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `Date` constructed with `Date.UTC` back to a `'YYYY-MM-DD'` string. */
function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FiscalYearBounds {
  startDate: string; // 'YYYY-MM-DD'
  endDate: string; // 'YYYY-MM-DD'
  label: string;
}

/**
 * The fiscal year containing the date `on`, given a start month/day.
 *
 * `endDate` is one day before the following year's start, computed by
 * subtracting exactly one day in milliseconds — safe because
 * `fiscal_year_start_day` is capped at 28, so "the day before" never has to
 * reason about a month's actual length.
 *
 * `label` reads "FY 2026" for a calendar-aligned year (Jan 1 start) and
 * "FY 2026–27" (en dash) for a split year, matching how a straddling fiscal
 * year is conventionally written.
 */
export function fiscalYearBounds(startMonth: number, startDay: number, on: string): FiscalYearBounds {
  const { year, month, day } = parseIsoDate(on);

  const onOrAfterStart = month > startMonth || (month === startMonth && day >= startDay);
  const fyStartYear = onOrAfterStart ? year : year - 1;

  const startDate = `${fyStartYear}-${pad2(startMonth)}-${pad2(startDay)}`;
  const nextStart = Date.UTC(fyStartYear + 1, startMonth - 1, startDay);
  const endDate = toIsoDate(new Date(nextStart - 86_400_000));

  const label =
    startMonth === 1 && startDay === 1
      ? `FY ${fyStartYear}`
      : `FY ${fyStartYear}–${String(fyStartYear + 1).slice(2)}`;

  return { startDate, endDate, label };
}

/** The calendar month containing `on`, as `[firstDay, lastDay]`. */
export function monthBounds(on: string): { startDate: string; endDate: string } {
  const { year, month } = parseIsoDate(on);
  const startDate = toIsoDate(new Date(Date.UTC(year, month - 1, 1)));
  // Day 0 of the following month is the last day of this one.
  const endDate = toIsoDate(new Date(Date.UTC(year, month, 0)));
  return { startDate, endDate };
}

/**
 * The first day of the month `count - 1` months before `on`'s month.
 *
 * `monthsBackStart(on, 6)` is "the start of the 6-month trend window ending in
 * `on`'s month" — negative month indices in `Date.UTC` normalize by borrowing
 * from the year, which is what lets this cross a year boundary for free.
 */
export function monthsBackStart(on: string, count: number): string {
  const { year, month } = parseIsoDate(on);
  return toIsoDate(new Date(Date.UTC(year, month - 1 - (count - 1), 1)));
}

export interface FiscalPeriodRange {
  periodNumber: number; // 1-12
  startsOn: string; // 'YYYY-MM-DD'
  endsOn: string; // 'YYYY-MM-DD'
}

/**
 * The twelve monthly periods of the fiscal year containing `on`.
 *
 * Period 1 starts on the fiscal year's start date; period k starts on the
 * same day-of-month `k - 1` months later; each period ends the day before
 * the next one starts, and period 12 ends on the fiscal year's end date.
 * `fiscal_year_start_day` is capped at 28 by the settings schema, so "the
 * same day next month" always exists and no month-length reasoning is needed.
 */
export function fiscalPeriodRanges(startMonth: number, startDay: number, on: string): FiscalPeriodRange[] {
  const { startDate, endDate } = fiscalYearBounds(startMonth, startDay, on);
  const { year: fyStartYear } = parseIsoDate(startDate);

  const ranges: FiscalPeriodRange[] = [];
  for (let k = 0; k < 12; k++) {
    const startsOn = toIsoDate(new Date(Date.UTC(fyStartYear, startMonth - 1 + k, startDay)));
    const endsOn =
      k === 11 ? endDate : toIsoDate(new Date(Date.UTC(fyStartYear, startMonth - 1 + k + 1, startDay) - 86_400_000));
    ranges.push({ periodNumber: k + 1, startsOn, endsOn });
  }
  return ranges;
}
