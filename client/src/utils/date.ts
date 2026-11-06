const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const DISPLAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const AU_DISPLAY = new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });

/**
 * Phase 49a: the active organization's calendar. A module variable rather than
 * context because `formatDate` is called from hundreds of plain functions.
 * `LedgerSettingsProvider` keeps it current; null means a GENERIC organization,
 * which keeps its browser-locale dates and UTC "today" exactly as before.
 */
let australianZone: string | null = null;

export function configureOrgCalendar(region: string, timeZone: string): void {
  australianZone = region === 'AU' ? timeZone : null;
}

/**
 * A calendar date ('2026-09-03') for display — "3 Sep 2026" / "Sep 3, 2026"
 * per the browser's locale, or 03/09/2026 for an Australian organization
 * whatever the browser's locale.
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
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (australianZone === null ? DISPLAY : AU_DISPLAY).format(utc);
}

function dateInZone(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type: 'year' | 'month' | 'day'): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * "Today" as YYYY-MM-DD: the organization's own date for an Australian
 * organization, where UTC is still yesterday until late morning, and UTC
 * otherwise.
 */
export function orgToday(now: Date = new Date()): string {
  return australianZone === null ? now.toISOString().slice(0, 10) : dateInZone(australianZone, now);
}

/**
 * A Date whose UTC fields read as the organization's calendar date, for the
 * report presets that do month arithmetic with `getUTCFullYear()` and friends.
 * A GENERIC organization gets `now` untouched.
 */
export function orgNow(now: Date = new Date()): Date {
  return australianZone === null ? now : new Date(`${dateInZone(australianZone, now)}T00:00:00Z`);
}
