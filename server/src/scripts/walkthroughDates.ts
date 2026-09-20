/**
 * Date arithmetic shared by the walkthrough generator, its answer-key
 * computation, and its tests — one implementation, so a date computed while
 * writing `statements/*.csv` can never drift from the date computed while
 * checking the same figure in `07-expected-results.md`.
 *
 * Anchor-relative, never absolute: `--anchor 2026-06` means month 1 is June
 * 2026, month 2 is July, month 3 is August — resolved with `Date.UTC`
 * integer arithmetic, never `new Date(dateString)` (see
 * `utils/dateParse.ts`'s header for why: JS's built-in parser is
 * inconsistent across engines and never fails cleanly).
 */

export interface AnchorMonth {
  year: number;
  /** 1-indexed. */
  month: number;
}

const ANCHOR_RE = /^(\d{4})-(\d{2})$/;

export function parseAnchor(raw: string): AnchorMonth {
  const match = ANCHOR_RE.exec(raw);
  if (match === null) {
    throw new Error('Usage: npm run walkthrough -- --anchor YYYY-MM');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error('Usage: npm run walkthrough -- --anchor YYYY-MM');
  }
  return { year, month };
}

/** Three months back from today, 1st of the month — the no-argument default. */
export function defaultAnchor(): AnchorMonth {
  const now = new Date();
  const totalMonths = now.getUTCFullYear() * 12 + now.getUTCMonth() - 3;
  return { year: Math.floor(totalMonths / 12), month: (totalMonths % 12) + 1 };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `walkthroughMonth` 1, 2 or 3 relative to the anchor; `day` 1-28. Returns 'YYYY-MM-DD'. */
export function resolveDate(anchor: AnchorMonth, walkthroughMonth: 1 | 2 | 3, day: number): string {
  if (day < 1 || day > 28) throw new Error(`walkthrough date day out of range: ${String(day)}`);
  const totalMonths = anchor.year * 12 + (anchor.month - 1) + (walkthroughMonth - 1);
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  return `${String(year)}-${pad2(month)}-${pad2(day)}`;
}

/** The last calendar day of a walkthrough month, as 'YYYY-MM-DD'. */
export function lastDayOfWalkthroughMonth(anchor: AnchorMonth, walkthroughMonth: 1 | 2 | 3): string {
  const totalMonths = anchor.year * 12 + (anchor.month - 1) + (walkthroughMonth - 1);
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  // Day 0 of the following month is the last day of `month` (1-indexed) — the
  // same trick utils/dateParse.ts's daysInMonth uses.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year)}-${pad2(month)}-${pad2(lastDay)}`;
}

/** Shifts an ISO date ('YYYY-MM-DD') by a signed number of whole days. */
export function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days);
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days between two ISO dates, b - a. */
export function daysBetweenIso(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const ta = Date.UTC(ay ?? 0, (am ?? 1) - 1, ad ?? 1);
  const tb = Date.UTC(by ?? 0, (bm ?? 1) - 1, bd ?? 1);
  return Math.round((tb - ta) / 86_400_000);
}
