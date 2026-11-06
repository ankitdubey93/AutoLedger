import type { BasCycle } from '../config/regions.js';

/**
 * BAS periods and due dates. Pure, on YYYY-MM-DD strings with UTC arithmetic.
 *
 * Quarterly periods are calendar quarters whatever the financial year is.
 * Due dates are the ATO's standard ones. Agent programs and online-lodgment
 * extensions vary by taxpayer, so they are not calculated here.
 */

function iso(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function parts(date: string): { year: number; monthIndex: number } {
  return { year: Number(date.slice(0, 4)), monthIndex: Number(date.slice(5, 7)) - 1 };
}

export interface BasPeriod {
  start: string;
  end: string;
}

export function basPeriodContaining(date: string, cycle: BasCycle): BasPeriod {
  const { year, monthIndex } = parts(date);
  const first = cycle === 'MONTHLY' ? monthIndex : Math.floor(monthIndex / 3) * 3;
  const months = cycle === 'MONTHLY' ? 1 : 3;
  return { start: iso(year, first, 1), end: iso(year, first + months, 0) };
}

export function previousBasPeriod(period: BasPeriod, cycle: BasCycle): BasPeriod {
  const { year, monthIndex } = parts(period.start);
  return basPeriodContaining(iso(year, monthIndex, 0), cycle);
}

export function isBasPeriodStart(date: string, cycle: BasCycle): boolean {
  return basPeriodContaining(date, cycle).start === date;
}

export function basDueDate(periodEnd: string, cycle: BasCycle): string {
  const { year, monthIndex } = parts(periodEnd);
  if (cycle === 'MONTHLY') return iso(year, monthIndex + 1, 21);
  // The December quarter gets a month longer: 28 February.
  return monthIndex === 11 ? iso(year + 1, 1, 28) : iso(year, monthIndex + 1, 28);
}
