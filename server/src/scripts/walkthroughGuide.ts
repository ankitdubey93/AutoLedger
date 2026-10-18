import { readdirSync, readFileSync } from 'node:fs';
import { allCustomers, allVendors, WALKTHROUGH_DATASET } from './walkthroughDataset.js';
import { monthName, resolveDate, type AnchorMonth, type ScenarioMonth } from './walkthroughDates.js';
import { DEMO_DEFAULT_EMAIL, DEMO_DEFAULT_PASSWORD, accountName, customerName, vendorName } from './walkthroughNames.js';

/**
 * Renders `walkthrough/guide/` from the markdown templates in
 * `walkthroughGuide/`. A template is prose with `{{token}}` placeholders; the
 * token set is closed (see `fillGuideTokens`) and anything outside it, or any
 * brace left after filling, throws — so a renamed customer, a deleted
 * account or a typo in a template fails the generator instead of shipping
 * wrong prose. The guide is generated output, like the rest of `walkthrough/`.
 */

/** `{{name}}`, `{{name:arg}}` or `{{name:arg:arg2}}`. */
const TOKEN = /\{\{([a-z.]+)(?::([^}:]+))?(?::([^}]+))?\}\}/g;

function monthArg(token: string, fileName: string, raw: string | undefined): ScenarioMonth {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error(`walkthrough guide: unknown token ${token} in ${fileName}`);
  return n as ScenarioMonth;
}

function docLabel(ref: string): string {
  const doc = [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills].find((d) => d.ref === ref);
  if (doc === undefined) throw new Error(`walkthrough guide: no document ${ref}`);
  const isInvoice = WALKTHROUGH_DATASET.invoices.some((d) => d.ref === ref);
  return `${ref} (${isInvoice ? customerName(doc.counterpartyKey) : vendorName(doc.counterpartyKey)})`;
}

export function fillGuideTokens(anchor: AnchorMonth, fileName: string, text: string): string {
  const filled = text.replace(TOKEN, (token: string, name: string, arg: string | undefined, arg2: string | undefined) => {
    const unknown = (): never => {
      throw new Error(`walkthrough guide: unknown token ${token} in ${fileName}`);
    };
    switch (name) {
      case 'customer': {
        if (arg === undefined || arg2 !== undefined) return unknown();
        const c = allCustomers().find((x) => x.key === arg);
        return c === undefined ? unknown() : c.name;
      }
      case 'vendor': {
        if (arg === undefined || arg2 !== undefined) return unknown();
        const v = allVendors().find((x) => x.key === arg);
        return v === undefined ? unknown() : v.name;
      }
      case 'doc':
        if (arg === undefined || arg2 !== undefined) return unknown();
        try {
          return docLabel(arg);
        } catch {
          return unknown();
        }
      case 'account':
        if (arg === undefined || arg2 !== undefined) return unknown();
        try {
          return `\`${accountName(arg)}\``;
        } catch {
          return unknown();
        }
      case 'date': {
        if (arg === undefined || arg2 === undefined) return unknown();
        const day = Number(arg2);
        if (!Number.isInteger(day) || day < 1 || day > 28) return unknown();
        return resolveDate(anchor, monthArg(token, fileName, arg), day);
      }
      case 'month':
        if (arg === undefined || arg2 !== undefined) return unknown();
        return monthName(anchor, monthArg(token, fileName, arg));
      case 'demo.email':
        return arg === undefined ? DEMO_DEFAULT_EMAIL : unknown();
      case 'demo.password':
        return arg === undefined ? DEMO_DEFAULT_PASSWORD : unknown();
      default:
        return unknown();
    }
  });
  if (filled.includes('{{')) throw new Error(`walkthrough guide: unfilled braces in ${fileName}`);
  return filled;
}

/** Every `*.md` template, sorted by file name, filled for `anchor`; each lands at `guide/<name>`. */
export function renderGuide(anchor: AnchorMonth): { path: string; content: string }[] {
  const dir = new URL('./walkthroughGuide/', import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({
      path: `guide/${name}`,
      content: fillGuideTokens(anchor, name, readFileSync(new URL(name, dir), 'utf8')),
    }));
}
