/**
 * Phase 48 — which reminder offset, if any, is due for an invoice right now.
 * Pure: `today` is an argument, never read from the clock. All dates are UTC
 * 'YYYY-MM-DD' and all calendar arithmetic goes through Date.UTC / getUTC*.
 *
 * Rules: an offset has passed when `dueDate + offset days <= today`. Only the
 * largest passed offset is ever sent (catch-up sends one reminder, never the
 * smaller missed ones). Nothing is sent when that offset has already been sent,
 * or any larger one has.
 */
export function reminderOffsetDue(
  dueDate: string,
  today: string,
  offsets: readonly number[],
  alreadySent: readonly number[],
): number | null {
  let largest: number | null = null;
  for (const offset of offsets) {
    if (addDaysIso(dueDate, offset) <= today && (largest === null || offset > largest)) {
      largest = offset;
    }
  }
  if (largest === null) return null;

  if (alreadySent.length > 0 && Math.max(...alreadySent) >= largest) return null;
  return largest;
}

function addDaysIso(isoDate: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
