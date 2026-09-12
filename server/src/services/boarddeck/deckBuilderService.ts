import PptxGenJSImport from 'pptxgenjs';
import type { BoardDeckCloseCheck } from '../../types/boarddeck.js';
import type { BalanceSheet, ProfitAndLoss } from '../../types/ledger-core.js';
import type { SummarizedVariance } from '../../utils/boarddeckVariance.js';

/**
 * BoardDeck (Phase 15) — renders the .pptx artifact from already-fetched
 * data. This file contains no SQL and imports nothing from db/ or from
 * another app's service (guardrails rule 16) — it takes data, not ids, so
 * it is testable without Postgres.
 *
 * pptxgenjs's own `.d.ts` (verified at v4.0.1) declares its exports via a
 * `declare class PptxGenJS {} + declare namespace PptxGenJS {}` merge with
 * `export default`, which normally lets an importer write `PptxGenJS.Slide`
 * etc. as a type. Under this project's `"module": "NodeNext"` (required —
 * it is the only resolution mode matching how Node actually resolves ESM at
 * runtime) combined with TypeScript 7.0.2 and pptxgenjs's single
 * (non-import/require-split) `exports.types` field, the default-import
 * binding instead resolves to `typeof import(".../types/index")` — the
 * whole file's own top-level exports, which does not include the
 * namespace's nested members — so `new PptxGenJS()` and `PptxGenJS.TableRow`
 * both fail to typecheck even though the runtime import is correct
 * (verified: `typeof (await import('pptxgenjs')).default === 'function'`).
 * Confirmed independently: the same import typechecks cleanly under
 * `moduleResolution: "Bundler"` — this is a NodeNext-resolution-only defect
 * in the package/TS7 combination, not a real API gap or a bug in this file.
 *
 * The fix is a narrow, hand-written interface for exactly the slice of the
 * API this file calls, with one explicit assertion narrowing the
 * (mistyped) import to it — never `any`, never `@ts-ignore`, and the
 * project's tsconfig is untouched.
 */

interface PptxTextOptions {
  x: number;
  y: number;
  w: number;
  h?: number;
  fontSize: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}

interface PptxTableOptions {
  x: number;
  y: number;
  w: number;
  colW?: number[];
  fontSize: number;
}

interface PptxTableCell {
  text: string;
}

type PptxTableRow = PptxTableCell[];

interface PptxSlide {
  addText(text: string, options: PptxTextOptions): PptxSlide;
  addTable(rows: PptxTableRow[], options: PptxTableOptions): PptxSlide;
}

interface PptxPresentation {
  addSlide(): PptxSlide;
  write(props: { outputType: 'nodebuffer' }): Promise<Uint8Array>;
}

const PptxGenJS = PptxGenJSImport as unknown as new () => PptxPresentation;

export interface DeckInput {
  orgName: string;
  baseCurrency: string;
  title: string;
  periodStartsOn: string;
  periodEndsOn: string;
  profitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  /** [] when no close run exists for this period. */
  closeChecks: BoardDeckCloseCheck[];
  /** null when the deck was created without a plan. */
  bva: SummarizedVariance | null;
}

/**
 * Formats integer cents as "<currency> -1234.56" by integer arithmetic
 * only — never `cents / 100` or `toFixed` (guardrails rule 3).
 */
function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  const magnitude = Math.abs(cents);
  const whole = Math.trunc(magnitude / 100);
  const remainder = magnitude % 100;
  const remainderStr = remainder < 10 ? `0${String(remainder)}` : String(remainder);
  return `${currency} ${sign}${String(whole)}.${remainderStr}`;
}

function addTitleSlide(pptx: PptxPresentation, input: DeckInput): void {
  const slide = pptx.addSlide();
  slide.addText(input.title, { x: 0.5, y: 1.5, w: 9, h: 1, fontSize: 32, bold: true, align: 'center' });
  slide.addText(input.orgName, { x: 0.5, y: 2.6, w: 9, h: 0.6, fontSize: 20, align: 'center' });
  slide.addText(`${input.periodStartsOn} — ${input.periodEndsOn}`, {
    x: 0.5,
    y: 3.3,
    w: 9,
    h: 0.5,
    fontSize: 14,
    align: 'center',
  });
}

function addProfitAndLossSlide(pptx: PptxPresentation, input: DeckInput): void {
  const slide = pptx.addSlide();
  slide.addText('Profit & Loss', { x: 0.3, y: 0.2, w: 9, h: 0.6, fontSize: 22, bold: true });

  const p = input.profitAndLoss;
  const rows: PptxTableRow[] = [
    [{ text: 'Revenue' }, { text: formatCents(p.revenue.totalCents, input.baseCurrency) }],
    [{ text: 'Cost of Sales' }, { text: formatCents(p.costOfSales.totalCents, input.baseCurrency) }],
    [{ text: 'Gross Profit' }, { text: formatCents(p.grossProfitCents, input.baseCurrency) }],
    [{ text: 'Operating Expenses' }, { text: formatCents(p.operatingExpenses.totalCents, input.baseCurrency) }],
    [{ text: 'Net Income' }, { text: formatCents(p.netIncomeCents, input.baseCurrency) }],
  ];
  slide.addTable(rows, { x: 0.3, y: 1.0, w: 9, colW: [5, 4], fontSize: 14 });
}

function addBalanceSheetSlide(pptx: PptxPresentation, input: DeckInput): void {
  const slide = pptx.addSlide();
  slide.addText('Balance Sheet', { x: 0.3, y: 0.2, w: 9, h: 0.6, fontSize: 22, bold: true });

  const b = input.balanceSheet;
  const rows: PptxTableRow[] = [
    [{ text: 'Assets' }, { text: formatCents(b.assets.totalCents, input.baseCurrency) }],
    [{ text: 'Liabilities' }, { text: formatCents(b.liabilities.totalCents, input.baseCurrency) }],
    [{ text: 'Equity' }, { text: formatCents(b.equity.totalCents, input.baseCurrency) }],
    [{ text: 'Assets = Liabilities + Equity' }, { text: b.balances ? 'YES' : 'NO' }],
  ];
  slide.addTable(rows, { x: 0.3, y: 1.0, w: 9, colW: [5, 4], fontSize: 14 });
}

function addBvaSlide(pptx: PptxPresentation, input: DeckInput, bva: SummarizedVariance): void {
  const slide = pptx.addSlide();
  slide.addText('Budget vs Actual', { x: 0.3, y: 0.2, w: 9, h: 0.6, fontSize: 22, bold: true });

  const rows: PptxTableRow[] = [
    [{ text: 'Section' }, { text: 'Budget' }, { text: 'Actual' }, { text: 'Variance' }, { text: 'Fav/Unfav' }],
    ...bva.sections.map(
      (s): PptxTableRow => [
        { text: s.section },
        { text: formatCents(s.budgetCents, input.baseCurrency) },
        { text: formatCents(s.actualCents, input.baseCurrency) },
        { text: formatCents(s.varianceCents, input.baseCurrency) },
        { text: s.favourable ? 'Fav' : 'Unfav' },
      ],
    ),
  ];
  slide.addTable(rows, { x: 0.3, y: 1.0, w: 9, colW: [3, 2, 2, 2, 1.5], fontSize: 12 });
}

function addTopDriversSlide(pptx: PptxPresentation, input: DeckInput, bva: SummarizedVariance): void {
  const slide = pptx.addSlide();
  slide.addText('Top Variance Drivers', { x: 0.3, y: 0.2, w: 9, h: 0.6, fontSize: 22, bold: true });

  if (bva.drivers.length === 0) {
    slide.addTable([[{ text: 'No variance to report' }]], { x: 0.3, y: 1.0, w: 9, fontSize: 14 });
    return;
  }

  const rows: PptxTableRow[] = [
    [{ text: 'Code' }, { text: 'Account' }, { text: 'Variance' }, { text: 'Fav/Unfav' }],
    ...bva.drivers.map(
      (d): PptxTableRow => [
        { text: d.accountCode },
        { text: d.accountName },
        { text: formatCents(d.varianceCents, input.baseCurrency) },
        { text: d.favourable ? 'Fav' : 'Unfav' },
      ],
    ),
  ];
  slide.addTable(rows, { x: 0.3, y: 1.0, w: 9, colW: [1.5, 4, 2, 1.5], fontSize: 12 });
}

function addCloseChecklistSlide(pptx: PptxPresentation, checks: BoardDeckCloseCheck[]): void {
  const slide = pptx.addSlide();
  slide.addText('Close Checklist', { x: 0.3, y: 0.2, w: 9, h: 0.6, fontSize: 22, bold: true });

  if (checks.length === 0) {
    slide.addTable([[{ text: 'No close run for this period' }]], { x: 0.3, y: 1.0, w: 9, fontSize: 14 });
    return;
  }

  const rows: PptxTableRow[] = [
    [{ text: 'Check' }, { text: 'Result' }, { text: 'Detail' }],
    ...checks.map((c): PptxTableRow => [{ text: c.kind }, { text: c.result }, { text: c.detail }]),
  ];
  slide.addTable(rows, { x: 0.3, y: 1.0, w: 9, colW: [3, 1.5, 4.5], fontSize: 12 });
}

export async function buildDeck(input: DeckInput): Promise<{ buffer: Buffer; slideCount: number }> {
  const pptx = new PptxGenJS();

  addTitleSlide(pptx, input);
  addProfitAndLossSlide(pptx, input);
  addBalanceSheetSlide(pptx, input);

  let slideCount = 3;
  if (input.bva !== null) {
    addBvaSlide(pptx, input, input.bva);
    addTopDriversSlide(pptx, input, input.bva);
    slideCount += 2;
  }

  addCloseChecklistSlide(pptx, input.closeChecks);
  slideCount += 1;

  const written = await pptx.write({ outputType: 'nodebuffer' });
  const buffer = Buffer.from(written);

  return { buffer, slideCount };
}
