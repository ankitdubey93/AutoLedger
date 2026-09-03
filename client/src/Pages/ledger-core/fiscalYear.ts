/**
 * Client mirror of server/src/utils/fiscalYear.ts — ported, not redesigned, so
 * the onboarding wizard can show the derived fiscal-year end date live without
 * a round trip. Same algorithm, same rule: never `new Date(isoString)` on a
 * bare date string, which parses at local midnight and can shift the calendar
 * date at a positive UTC offset.
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

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FiscalYearBounds {
  startDate: string;
  endDate: string;
  label: string;
}

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
