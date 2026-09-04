/**
 * A flexible date parser for bank statement CSV imports.
 *
 * Bank exports disagree on date order (`DD/MM/YYYY` vs `MM/DD/YYYY`) and on
 * whether the month is numeric or a three-letter name. `dateFormat` resolves
 * the numeric ambiguity explicitly — there is no way to detect `DMY` vs
 * `MDY` from the data alone when the day is <= 12, so this never guesses.
 *
 * Never `new Date(text)`: JS's built-in parser accepts wildly inconsistent
 * formats inconsistently across engines and silently produces `Invalid
 * Date` or a wrong date rather than a clean parse failure. Every date here
 * is validated against the real calendar and returned as a plain
 * `'YYYY-MM-DD'` string — see utils/fiscalYear.ts's header comment for the
 * sibling reasoning against `new Date(isoString).toISOString()`.
 */

export const DATE_FORMATS = ['ISO', 'DMY', 'MDY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function isDateFormat(value: string): value is DateFormat {
  return (DATE_FORMATS as readonly string[]).includes(value);
}

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

function monthIndexFromName(name: string): number | null {
  const key = name.slice(0, 3).toLowerCase();
  const idx = MONTH_NAMES.indexOf(key as (typeof MONTH_NAMES)[number]);
  return idx === -1 ? null : idx + 1;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Day 0 of the following month is the last day of `month` (1-indexed). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function resolveYear(yy: number): number {
  if (yy >= 100) return yy;
  return yy < 70 ? 2000 + yy : 1900 + yy;
}

function buildIfValid(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year)}-${pad2(month)}-${pad2(day)}`;
}

// Day-first, month-name form: "9 Mar 2026", "09-MAR-2026", "09/Mar/26".
const DAY_MONTH_YEAR_RE = /^(\d{1,2})[\s\-/]+([A-Za-z]{3,9})[.,\s\-/]+(\d{2,4})$/;
// Month-first, month-name form: "Mar 9 2026", "Mar 9, 2026", "March 9, 2026".
const MONTH_DAY_YEAR_RE = /^([A-Za-z]{3,9})[\s\-/]+(\d{1,2}),?[\s\-/]*(\d{2,4})$/;

/** Returns 'YYYY-MM-DD', or null when the text is not a real calendar date. */
export function parseFlexibleDate(raw: string, format: DateFormat): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Month-name forms are tried first, regardless of `format` — a spelled-out
  // month is unambiguous, so there is nothing for `format` to resolve.
  const dmyNameMatch = DAY_MONTH_YEAR_RE.exec(trimmed);
  if (dmyNameMatch) {
    const dayStr = dmyNameMatch[1] ?? '';
    const monthName = dmyNameMatch[2] ?? '';
    const yearStr = dmyNameMatch[3] ?? '';
    const month = monthIndexFromName(monthName);
    if (month !== null) {
      return buildIfValid(resolveYear(Number(yearStr)), month, Number(dayStr));
    }
  }

  const mdyNameMatch = MONTH_DAY_YEAR_RE.exec(trimmed);
  if (mdyNameMatch) {
    const monthName = mdyNameMatch[1] ?? '';
    const dayStr = mdyNameMatch[2] ?? '';
    const yearStr = mdyNameMatch[3] ?? '';
    const month = monthIndexFromName(monthName);
    if (month !== null) {
      return buildIfValid(resolveYear(Number(yearStr)), month, Number(dayStr));
    }
  }

  // Numeric form: split on the first run of -, / or . into exactly three parts.
  const parts = trimmed.split(/[-/.]/);
  if (parts.length !== 3) return null;
  const [p1, p2, p3] = parts;
  if (p1 === undefined || p2 === undefined || p3 === undefined) return null;
  if (!/^\d+$/.test(p1) || !/^\d+$/.test(p2) || !/^\d+$/.test(p3)) return null;

  // A 4-digit first part is unambiguously a year, regardless of `format`.
  if (p1.length === 4) {
    return buildIfValid(Number(p1), Number(p2), Number(p3));
  }

  if (format === 'ISO') return null;

  const year = resolveYear(Number(p3));
  if (format === 'DMY') {
    return buildIfValid(year, Number(p2), Number(p1));
  }
  // MDY
  return buildIfValid(year, Number(p1), Number(p2));
}
