/**
 * `{{name}}` substitution over a CLOSED whitelist (Phase 39b) — the whole of
 * the "template language" behind user-editable statement emails.
 *
 * Deliberately not a template engine (rule 14): no conditionals, loops,
 * filters, partials or expressions, so a user-authored template can do
 * nothing but name a value we chose to expose. Output is plain text; the HTML
 * email part escapes it (`templates.ts` `esc`) after substitution, so a
 * customer named `<script>` arrives as text, and a template author cannot
 * inject markup either.
 */

export const STATEMENT_PLACEHOLDERS = [
  'contact_name',
  'organization_name',
  'balance_due',
  'overdue_amount',
  'statement_date',
  'period_from',
  'period_to',
  'open_invoice_count',
] as const;
export type StatementPlaceholder = (typeof STATEMENT_PLACEHOLDERS)[number];

export type PlaceholderValues = Record<StatementPlaceholder, string>;

/** Matches `{{ name }}` — whitespace inside the braces is tolerated. */
const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function isPlaceholder(name: string): name is StatementPlaceholder {
  return (STATEMENT_PLACEHOLDERS as readonly string[]).includes(name);
}

/** Every `{{name}}` in `text` that is not on the whitelist, de-duplicated, in order. */
export function unknownPlaceholders(text: string): string[] {
  const unknown: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const name = match[1] ?? '';
    if (!isPlaceholder(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/**
 * Replaces each whitelisted `{{name}}` with its value. A single pass over
 * the original text: a value that itself contains `{{...}}` (a customer
 * named "{{balance_due}}") is inserted literally, never re-expanded.
 * Unknown names are left as written — saving a template already refuses them.
 */
export function fillPlaceholders(text: string, values: PlaceholderValues): string {
  return text.replace(TOKEN, (whole, name: string) => (isPlaceholder(name) ? values[name] : whole));
}
