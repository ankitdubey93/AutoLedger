/**
 * Comparison-period arithmetic for the P&L comparison report (Phase 45).
 * Pure, no DB import — every date is a `'YYYY-MM-DD'` string, parsed by
 * splitting on `-` and built with `Date.UTC`, never `new Date(isoString)`
 * (see utils/fiscalYear.ts for why).
 */

export const COMPARISON_MODES = ['previousPeriod', 'samePeriodLastYear'] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export interface ComparisonPeriod {
  from: string;
  to: string;
  label: string;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 86_400_000;

interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
}

function parse(iso: string): Parts {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Not a YYYY-MM-DD date: "${iso}"`);
  }
  return { year, month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function format(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** from is the 1st and to is the last day of its month. */
export function isMonthAligned(from: string, to: string): boolean {
  const f = parse(from);
  const t = parse(to);
  return f.day === 1 && t.day === lastDayOfMonth(t.year, t.month);
}

/** '2026-03-31' + -1 → '2026-02-28'; '2024-02-29' + -12 → '2023-02-28'. */
export function addMonthsClamped(iso: string, months: number): string {
  const p = parse(iso);
  const index = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const day = Math.min(p.day, lastDayOfMonth(year, month));
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function addDays(iso: string, days: number): string {
  const p = parse(iso);
  return format(new Date(Date.UTC(p.year, p.month - 1, p.day) + days * DAY_MS));
}

function monthIndex(iso: string): number {
  const p = parse(iso);
  return p.year * 12 + (p.month - 1);
}

function monthAlignedLabel(from: string, to: string): string {
  const f = parse(from);
  const t = parse(to);
  const fromName = SHORT_MONTHS[f.month - 1];
  const toName = SHORT_MONTHS[t.month - 1];
  if (f.year === t.year && f.month === t.month) return `${fromName} ${f.year}`;
  if (f.year === t.year) return `${fromName}–${toName} ${f.year}`;
  return `${fromName} ${f.year}–${toName} ${t.year}`;
}

function periodFor(from: string, to: string): ComparisonPeriod {
  const label = isMonthAligned(from, to) ? monthAlignedLabel(from, to) : `${from}–${to}`;
  return { from, to, label };
}

/** Returns count + 1 periods: [current, prior 1, …, prior count]. count must be 1..11 (else RangeError). */
export function comparisonPeriods(from: string, to: string, mode: ComparisonMode, count: number): ComparisonPeriod[] {
  if (!Number.isInteger(count) || count < 1 || count > 11) {
    throw new RangeError('count must be between 1 and 11');
  }

  const periods: ComparisonPeriod[] = [periodFor(from, to)];

  if (isMonthAligned(from, to)) {
    const span = monthIndex(to) - monthIndex(from) + 1;
    const fromParts = parse(from);
    const toParts = parse(to);
    for (let k = 1; k <= count; k += 1) {
      const shift = mode === 'previousPeriod' ? k * span : 12 * k;
      const fromIdx = fromParts.year * 12 + (fromParts.month - 1) - shift;
      const toIdx = toParts.year * 12 + (toParts.month - 1) - shift;
      const fromYear = Math.floor(fromIdx / 12);
      const fromMonth = (fromIdx % 12) + 1;
      const toYear = Math.floor(toIdx / 12);
      const toMonth = (toIdx % 12) + 1;
      periods.push(
        periodFor(
          `${pad(fromYear, 4)}-${pad(fromMonth, 2)}-01`,
          `${pad(toYear, 4)}-${pad(toMonth, 2)}-${pad(lastDayOfMonth(toYear, toMonth), 2)}`,
        ),
      );
    }
    return periods;
  }

  const f = parse(from);
  const t = parse(to);
  const days = Math.round((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(f.year, f.month - 1, f.day)) / DAY_MS) + 1;
  for (let k = 1; k <= count; k += 1) {
    if (mode === 'previousPeriod') {
      periods.push(periodFor(addDays(from, -k * days), addDays(to, -k * days)));
    } else {
      periods.push(periodFor(addMonthsClamped(from, -12 * k), addMonthsClamped(to, -12 * k)));
    }
  }
  return periods;
}

/**
 * current − prior, and that change in bp of |prior| rounded half away from
 * zero; bp is null when prior is 0. bp is a display ratio, not money.
 */
export function variance(currentCents: number, priorCents: number): { cents: number; bp: number | null } {
  const cents = currentCents - priorCents;
  if (priorCents === 0) return { cents, bp: null };
  const x = (cents * 10000) / Math.abs(priorCents);
  return { cents, bp: Math.sign(x) * Math.round(Math.abs(x)) + 0 };
}
