/**
 * Xero-style placeholders (Phase 40) — the client's mirror of
 * `server/src/utils/placeholders.ts`. Kept line-for-line in step with it:
 * the editors preview unsaved text on every keystroke, and the invoice and
 * statement documents fill their settings text (footer, bank details, title)
 * when they render. The server stays authoritative for every persisted or
 * sent text; both suites run the same fixture,
 * `client/src/__tests__/fixtures/placeholderCases.json`.
 *
 * Only `nearMisses` and `upgradeLegacy`, at the bottom, are client-only.
 */

/** Where text is being filled — decides which placeholders exist there. */
export type PlaceholderSurface =
  | 'INVOICE'
  | 'BILL'
  | 'JOURNAL'
  | 'CREDIT_NOTE'
  | 'DEBIT_NOTE'
  | 'STATEMENT'
  | 'BANK_LINE';

export type PlaceholderKey =
  | 'day'
  | 'week'
  | 'month'
  | 'year'
  | 'date'
  | 'contactName'
  | 'organisationName'
  | 'dueDate'
  | 'occurrence'
  | 'invoiceNumber'
  | 'balanceDue'
  | 'overdueAmount'
  | 'statementDate'
  | 'periodFrom'
  | 'periodTo'
  | 'openInvoiceCount';

export interface PlaceholderDef {
  key: PlaceholderKey;
  /** The canonical spelling, written between brackets: `[Contact Name]`. */
  label: string;
  /** Other accepted spellings, compared after `normalise`. */
  aliases: readonly string[];
  /** The Phase 39b `{{snake_case}}` name, honoured on STATEMENT only. */
  legacy: string | null;
  /** Whether `[Name+n]` / `[Name-n]` is meaningful. */
  offset: boolean;
  surfaces: readonly PlaceholderSurface[];
  description: string;
}

const ALL: readonly PlaceholderSurface[] = [
  'INVOICE',
  'BILL',
  'JOURNAL',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'STATEMENT',
  'BANK_LINE',
];
const CONTACT: readonly PlaceholderSurface[] = ['INVOICE', 'BILL', 'CREDIT_NOTE', 'DEBIT_NOTE', 'STATEMENT'];

export const PLACEHOLDERS: readonly PlaceholderDef[] = [
  { key: 'day', label: 'Day', aliases: [], legacy: null, offset: true, surfaces: ALL, description: 'Day of the month, e.g. 10' },
  { key: 'week', label: 'Week', aliases: [], legacy: null, offset: true, surfaces: ALL, description: 'ISO week number, e.g. 41' },
  { key: 'month', label: 'Month', aliases: [], legacy: null, offset: true, surfaces: ALL, description: 'Month name, e.g. October' },
  { key: 'year', label: 'Year', aliases: [], legacy: null, offset: true, surfaces: ALL, description: 'Four-digit year, e.g. 2026' },
  { key: 'date', label: 'Date', aliases: [], legacy: null, offset: true, surfaces: ALL, description: 'The document date, e.g. 10 Oct 2026' },
  {
    key: 'contactName',
    label: 'Contact Name',
    aliases: ['customername', 'vendorname'],
    legacy: 'contact_name',
    offset: false,
    surfaces: CONTACT,
    description: 'The customer or vendor',
  },
  {
    key: 'organisationName',
    label: 'Organisation Name',
    aliases: ['organizationname'],
    legacy: 'organization_name',
    offset: false,
    surfaces: ALL,
    description: 'Your organisation',
  },
  {
    key: 'dueDate',
    label: 'Due Date',
    aliases: [],
    legacy: null,
    offset: false,
    surfaces: ['INVOICE', 'BILL'],
    description: 'The due date, e.g. 9 Nov 2026',
  },
  {
    key: 'occurrence',
    label: 'Occurrence',
    aliases: [],
    legacy: null,
    offset: false,
    surfaces: ['INVOICE', 'BILL', 'JOURNAL'],
    description: 'The run number of a recurring schedule',
  },
  {
    key: 'invoiceNumber',
    label: 'Invoice Number',
    aliases: [],
    legacy: null,
    offset: false,
    surfaces: ['INVOICE', 'CREDIT_NOTE'],
    description: 'The invoice number, set when issued',
  },
  { key: 'balanceDue', label: 'Balance Due', aliases: [], legacy: 'balance_due', offset: false, surfaces: ['STATEMENT'], description: 'Statement closing balance' },
  { key: 'overdueAmount', label: 'Overdue Amount', aliases: [], legacy: 'overdue_amount', offset: false, surfaces: ['STATEMENT'], description: 'Amount past due' },
  { key: 'statementDate', label: 'Statement Date', aliases: [], legacy: 'statement_date', offset: false, surfaces: ['STATEMENT'], description: 'The statement date' },
  { key: 'periodFrom', label: 'Period From', aliases: [], legacy: 'period_from', offset: false, surfaces: ['STATEMENT'], description: 'Activity statement start' },
  { key: 'periodTo', label: 'Period To', aliases: [], legacy: 'period_to', offset: false, surfaces: ['STATEMENT'], description: 'Statement end date' },
  {
    key: 'openInvoiceCount',
    label: 'Open Invoice Count',
    aliases: [],
    legacy: 'open_invoice_count',
    offset: false,
    surfaces: ['STATEMENT'],
    description: 'Number of open invoices or bills',
  },
];

/**
 * The values a surface can fill. `date` anchors the date family; every other
 * value is optional, and a missing one is handled by the fill mode.
 */
export interface PlaceholderContext {
  /** YYYY-MM-DD */
  date: string;
  contactName?: string | null;
  organisationName?: string | null;
  /** YYYY-MM-DD */
  dueDate?: string | null;
  occurrence?: number | null;
  invoiceNumber?: string | null;
  /** Pre-formatted money, e.g. "USD 1,250.00". */
  balanceDue?: string | null;
  overdueAmount?: string | null;
  /** YYYY-MM-DD */
  statementDate?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  openInvoiceCount?: number | null;
}

/**
 * `partial` — a known placeholder with no value yet (`[Invoice Number]` on a
 * draft) stays as written, to be filled later. `final` — it becomes empty, so
 * no placeholder ever reaches a posted document or a sent email.
 */
export type FillMode = 'partial' | 'final';

/**
 * `[[Month]]` (an escape: written out as a literal `[Month]`), `[ Name ]`,
 * `[Name+3]`, `[Name - 1]`, or the legacy `{{ snake_name }}`. One
 * alternation, so a fill is one pass over the original text. Groups:
 * 1 escaped text · 2 name · 3 sign · 4 offset · 5 legacy name.
 */
const TOKEN =
  /\[\[([^[\]\n]{1,40})\]\]|\[\s*([A-Za-z][A-Za-z ]{0,30}?)\s*(?:([+-])\s*(\d{1,3})\s*)?\]|\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function normalise(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '');
}

const BY_NAME = new Map<string, PlaceholderDef>();
const BY_LEGACY = new Map<string, PlaceholderDef>();
for (const def of PLACEHOLDERS) {
  BY_NAME.set(normalise(def.label), def);
  for (const alias of def.aliases) BY_NAME.set(alias, def);
  if (def.legacy !== null) BY_LEGACY.set(def.legacy, def);
}

/** The placeholders available on one surface, in registry order. */
export function placeholdersFor(surface: PlaceholderSurface): PlaceholderDef[] {
  return PLACEHOLDERS.filter((def) => def.surfaces.includes(surface));
}

// ---------------------------------------------------------------- date maths

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** en-GB abbreviations, as statement emails always printed them ("30 Sept 2026"). */
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'] as const;

const DAY_MS = 86_400_000;

function parseIso(iso: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) throw new Error(`Invalid date: ${iso}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function shiftDays(iso: string, days: number): [number, number, number] {
  const [y, m, d] = parseIso(iso);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
}

/** ISO-8601 week number: the week containing the year's first Thursday is week 1. */
function isoWeek(y: number, m: number, d: number): number {
  const t = Date.UTC(y, m - 1, d);
  const weekday = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = t + (3 - weekday) * DAY_MS;
  const jan1 = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thursday - jan1) / (7 * DAY_MS));
}

function monthName(month: number): string {
  return MONTHS[month - 1] ?? '';
}

function formatParts(y: number, m: number, d: number): string {
  return `${String(d)} ${SHORT_MONTHS[m - 1] ?? ''} ${String(y)}`;
}

/** "2026-10-10" → "10 Oct 2026". */
export function formatPlaceholderDate(iso: string): string {
  const [y, m, d] = parseIso(iso);
  return formatParts(y, m, d);
}

// ---------------------------------------------------------------- resolution

function optionalDate(iso: string | null | undefined): string | null {
  return iso === null || iso === undefined ? null : formatPlaceholderDate(iso);
}

function optionalText(value: string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** The filled value, or null when the context does not have it. */
function valueOf(key: PlaceholderKey, ctx: PlaceholderContext, offset: number): string | null {
  switch (key) {
    case 'day':
      return String(shiftDays(ctx.date, offset)[2]);
    case 'week': {
      const [y, m, d] = shiftDays(ctx.date, offset * 7);
      return String(isoWeek(y, m, d));
    }
    case 'month': {
      // Floor-mod: [Month-13] in March is February. The year is deliberately
      // untouched — [Month] and [Year] offset independently, as in Xero.
      const month = parseIso(ctx.date)[1];
      return monthName((((month - 1 + offset) % 12) + 12) % 12 + 1);
    }
    case 'year':
      return String(parseIso(ctx.date)[0] + offset);
    case 'date': {
      const [y, m, d] = shiftDays(ctx.date, offset);
      return formatParts(y, m, d);
    }
    case 'contactName':
      return optionalText(ctx.contactName);
    case 'organisationName':
      return optionalText(ctx.organisationName);
    case 'dueDate':
      return optionalDate(ctx.dueDate);
    case 'occurrence':
      return optionalText(ctx.occurrence);
    case 'invoiceNumber':
      return optionalText(ctx.invoiceNumber);
    case 'balanceDue':
      return optionalText(ctx.balanceDue);
    case 'overdueAmount':
      return optionalText(ctx.overdueAmount);
    case 'statementDate':
      return optionalDate(ctx.statementDate);
    case 'periodFrom':
      return optionalDate(ctx.periodFrom);
    case 'periodTo':
      return optionalDate(ctx.periodTo);
    case 'openInvoiceCount':
      return optionalText(ctx.openInvoiceCount);
  }
}

interface Match {
  def: PlaceholderDef;
  offset: number;
}

/**
 * The placeholder a regex match names on this surface, or null when it should
 * be left as written: an unknown name (square brackets are ordinary text —
 * "[draft]"), one not offered on this surface, an offset on a placeholder that
 * takes none, or `{{legacy}}` syntax anywhere but STATEMENT.
 */
function resolve(
  surface: PlaceholderSurface,
  name: string | undefined,
  sign: string | undefined,
  digits: string | undefined,
  legacy: string | undefined,
): Match | null {
  if (legacy !== undefined) {
    if (surface !== 'STATEMENT') return null;
    const def = BY_LEGACY.get(legacy);
    return def === undefined ? null : { def, offset: 0 };
  }
  const def = BY_NAME.get(normalise(name ?? ''));
  if (def === undefined || !def.surfaces.includes(surface)) return null;
  const offset = sign === undefined ? 0 : (sign === '-' ? -1 : 1) * Number(digits);
  if (offset !== 0 && !def.offset) return null;
  return { def, offset };
}

/**
 * Replaces each placeholder in `text`. A single pass over the original text:
 * a value that itself looks like a placeholder (a customer named "[Month]")
 * is inserted literally, never re-expanded.
 *
 * An escape, `[[Month]]`, becomes the literal `[Month]` in `final` mode only.
 * A `partial` fill keeps it escaped, because a partially filled text (a
 * recurring DRAFT) is filled again at issue — unescaping it the first time
 * would let the second fill expand it.
 */
export function fillPlaceholders(
  text: string,
  surface: PlaceholderSurface,
  ctx: PlaceholderContext,
  mode: FillMode = 'final',
): string {
  return text.replace(
    TOKEN,
    (
      whole,
      escaped: string | undefined,
      name: string | undefined,
      sign: string | undefined,
      digits: string | undefined,
      legacy: string | undefined,
    ) => {
      if (escaped !== undefined) return mode === 'final' ? `[${escaped}]` : whole;
      const match = resolve(surface, name, sign, digits, legacy);
      if (match === null) return whole;
      const value = valueOf(match.def.key, ctx, match.offset);
      if (value !== null) return value;
      return mode === 'final' ? '' : whole;
    },
  );
}

/** Whether `text` holds at least one placeholder this surface would fill. */
export function containsPlaceholders(text: string, surface: PlaceholderSurface): boolean {
  for (const m of text.matchAll(TOKEN)) {
    if (m[1] === undefined && resolve(surface, m[2], m[3], m[4], m[5]) !== null) return true;
  }
  return false;
}

/**
 * Every `{{name}}` in `text` that is not a legacy name, de-duplicated, in
 * order. Statement email templates refuse these (422): the double-brace form
 * was always validated, so an unknown one is a typo, not prose.
 */
export function unknownLegacyPlaceholders(text: string): string[] {
  const unknown: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const legacy = m[5];
    if (legacy !== undefined && !BY_LEGACY.has(legacy) && !unknown.includes(legacy)) unknown.push(legacy);
  }
  return unknown;
}

// ------------------------------------------------------------ client-only

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Non-blocking hints for bracket text that will be left as written but
 * probably meant to be a placeholder: a near-miss spelling, one not offered
 * here, or an offset on one that takes none. De-duplicated, in order.
 */
export function nearMisses(text: string, surface: PlaceholderSurface): string[] {
  const hints: string[] = [];
  const add = (hint: string) => {
    if (!hints.includes(hint)) hints.push(hint);
  };
  for (const m of text.matchAll(TOKEN)) {
    if (m[1] !== undefined || m[5] !== undefined || resolve(surface, m[2], m[3], m[4], m[5]) !== null) continue;
    const written = m[0];
    const key = normalise(m[2] ?? '');
    const def = BY_NAME.get(key);
    if (def !== undefined) {
      add(
        def.surfaces.includes(surface)
          ? `${written} — [${def.label}] does not take an offset`
          : `${written} — [${def.label}] is not available here`,
      );
      continue;
    }
    if (key.length < 3) continue;
    let best: PlaceholderDef | null = null;
    let bestDistance = 3;
    for (const [name, candidate] of BY_NAME) {
      if (!candidate.surfaces.includes(surface)) continue;
      const distance = levenshtein(key, name);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best !== null) add(`${written} — did you mean [${best.label}]?`);
  }
  return hints;
}

/** Rewrites every known `{{legacy_name}}` to its `[Bracket Label]`; unknown ones stay. */
export function upgradeLegacy(text: string): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, name: string) => {
    const def = BY_LEGACY.get(name);
    return def === undefined ? whole : `[${def.label}]`;
  });
}

/** Whether `text` still uses the Phase 39b double-brace syntax anywhere. */
export function hasLegacySyntax(text: string): boolean {
  return /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(text);
}
