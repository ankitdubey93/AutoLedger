/**
 * Organization-local calendar dates. Only quote dates use these (Phase 42,
 * Slice B); every other document keeps UTC "today". Pure: no database.
 * Relies on the platform's IANA zone database through `Intl`, never a
 * hand-written offset table, so daylight-saving rules stay correct.
 */

/** The calendar date (YYYY-MM-DD) at `now` in IANA `timeZone`; UTC when the zone is invalid. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch (err) {
    if (err instanceof RangeError) return now.toISOString().slice(0, 10);
    throw err;
  }
  const parts = formatter.formatToParts(now);
  const pick = (type: 'year' | 'month' | 'day'): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** True when `Intl` accepts the zone name (IANA name, case-insensitive). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
