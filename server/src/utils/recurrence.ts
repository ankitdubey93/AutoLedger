/**
 * Date arithmetic for recurring schedules. All dates are YYYY-MM-DD strings,
 * and all calculations use UTC via Date.UTC.
 *
 * The anchor-based model: given a start date and frequency, occurrence N is
 * computed from the anchor (startDate) every time, never from the previous
 * occurrence. This prevents calendar drift. Example: a 31st that hits February
 * clamps to the 28th (or 29th), but the next occurrence is the 31st of March
 * again, not a drift-day computed from February's clamped value.
 */

export type RecurrenceFrequency = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

function parseDate(date: string): [number, number, number] {
  const parts = date.split('-');
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('Invalid date: ' + date);
  }
  return [Number(year), Number(month), Number(day)];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Adds whole days to a YYYY-MM-DD date.
 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const da = pad2(d.getUTCDate());
  return `${y}-${m}-${da}`;
}

/**
 * The first day of the month after `date`.
 */
export function firstDayOfNextMonth(date: string): string {
  const [year, month] = parseDate(date);
  let nextMonth = month + 1;
  let nextYear = year;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  return `${nextYear}-${pad2(nextMonth)}-01`;
}

/**
 * The occurrenceIndex-th date of a schedule (index 0 = startDate), always
 * computed from the anchor startDate — never from the previous occurrence —
 * so a 31st does not drift to the 28th.
 *
 * WEEKLY adds 7*intervalCount*index days.
 * MONTHLY/QUARTERLY/YEARLY add (1|3|12)*intervalCount*index months,
 * clamping the anchor day to the target month's last day.
 *
 * Throws Error if occurrenceIndex is negative or non-integer.
 */
export function occurrenceDate(
  startDate: string,
  frequency: RecurrenceFrequency,
  intervalCount: number,
  occurrenceIndex: number,
): string {
  if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
    throw new Error('occurrenceIndex must be a non-negative integer');
  }

  if (occurrenceIndex === 0) {
    return startDate;
  }

  const [startYear, startMonth, startDay] = parseDate(startDate);

  if (frequency === 'WEEKLY') {
    const daysToAdd = 7 * intervalCount * occurrenceIndex;
    return addDays(startDate, daysToAdd);
  }

  // For MONTHLY, QUARTERLY, YEARLY: compute the target month
  let monthsToAdd = 0;
  if (frequency === 'MONTHLY') monthsToAdd = intervalCount * occurrenceIndex;
  else if (frequency === 'QUARTERLY') monthsToAdd = 3 * intervalCount * occurrenceIndex;
  else if (frequency === 'YEARLY') monthsToAdd = 12 * intervalCount * occurrenceIndex;

  let targetYear = startYear;
  let targetMonth = startMonth + monthsToAdd;

  // Normalize year and month
  while (targetMonth > 12) {
    targetMonth -= 12;
    targetYear += 1;
  }

  // Clamp the day to the last day of the target month
  const lastDayOfMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(startDay, lastDayOfMonth);

  const y = targetYear;
  const m = pad2(targetMonth);
  const d = pad2(targetDay);
  return `${y}-${m}-${d}`;
}
