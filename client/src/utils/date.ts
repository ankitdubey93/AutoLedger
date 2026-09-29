const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const DISPLAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * A calendar date ('2026-09-03') for display — "3 Sep 2026" / "Sep 3, 2026"
 * per the browser's locale.
 *
 * Parsed by hand and formatted in UTC, never `new Date('2026-09-03')` in
 * local time: that string is read as UTC midnight, so anywhere west of UTC it
 * would display as the day before. Anything that is not a plain date is
 * returned unchanged, and null reads as a dash.
 */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const match = DATE_ONLY.exec(value);
  if (match === null) return value;
  return DISPLAY.format(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}
