/**
 * Renders the three bank statement CSVs from the resolved settlement
 * lines, in three different real-world bank export shapes. Shared between
 * `generateWalkthrough.ts` (which writes them to disk) and
 * `walkthrough.test.ts` (which feeds them straight to the real importer,
 * in memory, without depending on the generated folder existing on disk).
 */
import { WALKTHROUGH_DATASET } from './walkthroughDataset.js';
import type { ResolvedSettlementLine } from './walkthroughTiers.js';
import { resolveDate, type AnchorMonth } from './walkthroughDates.js';
import { parseMoneyText } from '../utils/money.js';

export function money(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const withCommas = whole.toLocaleString('en-US');
  return `${negative ? '-' : ''}${withCommas}.${frac}`;
}

/**
 * No thousands separator — used only for statement 1's Amount column, a
 * comma-delimited CSV, where an unquoted embedded comma would corrupt
 * field-splitting.
 */
export function plainMoney(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${String(whole)}.${frac}`;
}

export function parenMoney(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const withCommas = whole.toLocaleString('en-US');
  return cents < 0 ? `($${withCommas}.${frac})` : `$${withCommas}.${frac}`;
}

export function csvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes(';')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function isoToDmy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function isoToMdy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function docByRefMap(): Map<string, (typeof WALKTHROUGH_DATASET.invoices)[number]> {
  return new Map([...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills].map((d) => [d.ref, d]));
}

/** Statement 1 — Northwind Bank: comma-delimited, ISO dates, one signed Amount column. */
export function statement1(anchor: AnchorMonth, lines: ResolvedSettlementLine[]): string {
  const rows = lines.filter((l) => l.month === 1).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  const noiseRows = WALKTHROUGH_DATASET.noise
    .filter((n) => n.month === 1)
    .map((n) => ({ isoDate: resolveDate(anchor, 1, n.day), description: n.description, amountCents: parseMoneyText(n.amount), reference: '' }));
  const docByRef = docByRefMap();
  const settlementRows = rows.map((l) => {
    const doc = docByRef.get(l.documentRef);
    const reference = doc !== undefined && doc.vendorReference !== null && l.lineRef === doc.ref ? doc.vendorReference : '';
    return { isoDate: l.isoDate, description: l.description, amountCents: l.amountCents, reference };
  });
  const all = [...settlementRows, ...noiseRows].sort((a, b) => a.isoDate.localeCompare(b.isoDate));

  const header = 'Date,Description,Reference,Amount';
  const body = all
    .map((r) => [r.isoDate, csvField(r.description), csvField(r.reference), plainMoney(r.amountCents)].join(','))
    .join('\n');
  return `${header}\n${body}\n`;
}

/** Statement 2 — Meridian Bank: semicolon-delimited, DMY dates, Debit/Credit pair. */
export function statement2(anchor: AnchorMonth, lines: ResolvedSettlementLine[]): string {
  const rows = lines.filter((l) => l.month === 2).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  const noiseRows = WALKTHROUGH_DATASET.noise
    .filter((n) => n.month === 2)
    .map((n) => ({ isoDate: resolveDate(anchor, 2, n.day), description: n.description, amountCents: parseMoneyText(n.amount) }));
  const all = [...rows, ...noiseRows].sort((a, b) => a.isoDate.localeCompare(b.isoDate));

  const header = 'Value Date;Narrative;Debit;Credit';
  const body = all
    .map((r) => {
      const debit = r.amountCents < 0 ? money(-r.amountCents) : '';
      const credit = r.amountCents > 0 ? money(r.amountCents) : '';
      return [isoToDmy(r.isoDate), csvField(r.description), debit, credit].join(';');
    })
    .join('\n');
  return `${header}\n${body}\n`;
}

/** Statement 3 — Cascade Trust: comma-delimited, MDY dates, $ amounts, parens negatives, non-synonym headers. */
export function statement3(anchor: AnchorMonth, lines: ResolvedSettlementLine[]): string {
  const rows = lines.filter((l) => l.month === 3).sort((a, b) => a.isoDate.localeCompare(b.isoDate));
  const noiseRows = WALKTHROUGH_DATASET.noise
    .filter((n) => n.month === 3)
    .map((n) => ({ isoDate: resolveDate(anchor, 3, n.day), description: n.description, amountCents: parseMoneyText(n.amount), checkNo: '' }));
  const docByRef = docByRefMap();
  const settlementRows = rows.map((l) => {
    const doc = docByRef.get(l.documentRef);
    const checkNo = doc !== undefined && doc.vendorReference !== null && l.lineRef === doc.ref ? doc.vendorReference : '';
    return { isoDate: l.isoDate, description: l.description, amountCents: l.amountCents, checkNo };
  });
  const all = [...settlementRows, ...noiseRows].sort((a, b) => a.isoDate.localeCompare(b.isoDate));

  const header = 'Posted,Memo,Check No,Net';
  const body = all
    .map((r) => [isoToMdy(r.isoDate), csvField(r.description), csvField(r.checkNo), csvField(parenMoney(r.amountCents))].join(','))
    .join('\n');
  return `${header}\n${body}\n`;
}
