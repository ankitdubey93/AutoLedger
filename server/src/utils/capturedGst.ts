import { auTaxCode } from '../config/taxPacks/au.js';
import { allocateCents, cents } from './money.js';

/**
 * Phase 49f — deciding the GST on a captured bill. Pure.
 *
 * A captured bill posts straight away, so a wrong guess reaches the BAS with
 * nobody looking. Where the receipt doesn't settle the question, this says so
 * and a person chooses, rather than spreading GST across GST-free lines.
 *
 * In order: what a reviewer chose; GST the receipt printed per line; no GST at
 * all; or GST that only fits if every line is taxable. Anything else is mixed
 * and needs review.
 */
export interface CapturedLine {
  amountCents: number;
  /** GST the receipt printed for this line. */
  extractedTaxCents: number | null;
  /** The code a reviewer chose. */
  chosenCode: string | null;
}

export interface DecidedLine {
  taxCode: string;
  netCents: number;
  taxCents: number;
}

export type CapturedGstDecision = { ok: true; lines: DecidedLine[] } | { ok: false; reason: string };

function grossMode(lines: readonly CapturedLine[], taxCents: number, totalCents: number): boolean {
  // Receipts often list prices that already include GST, so the lines alone reach the total.
  const sum = lines.reduce((s, l) => s + l.amountCents, 0);
  return taxCents > 0 && sum === totalCents;
}

/** Spreads tax over lines by amount. Only called once every line is known to be taxable. */
function spread(amounts: readonly number[], taxCents: number): number[] {
  return allocateCents(cents(taxCents), amounts.map((a) => cents(a))).map(Number);
}

export function decideCapturedGst(input: {
  registered: boolean;
  lines: readonly CapturedLine[];
  taxCents: number;
  totalCents: number;
}): CapturedGstDecision {
  const { registered, lines, taxCents, totalCents } = input;
  const inclusive = grossMode(lines, taxCents, totalCents);
  const finish = (taxes: readonly number[], codes: readonly string[]): CapturedGstDecision => ({
    ok: true,
    lines: lines.map((line, i) => {
      const tax = taxes[i] ?? 0;
      return { taxCode: codes[i] ?? 'P_FREE', netCents: inclusive ? line.amountCents - tax : line.amountCents, taxCents: tax };
    }),
  });

  if (!registered) {
    // No credit to claim, so the whole amount is the cost.
    const shares = taxCents > 0 && !inclusive ? spread(lines.map((l) => l.amountCents), taxCents) : lines.map(() => 0);
    return {
      ok: true,
      lines: lines.map((line, i) => ({ taxCode: 'P_EXCLUDED', netCents: line.amountCents + (shares[i] ?? 0), taxCents: 0 })),
    };
  }

  if (lines.every((l) => l.chosenCode !== null)) {
    const codes = lines.map((l) => l.chosenCode ?? '');
    const taxable = codes.map((code) => (auTaxCode(code)?.rateBp ?? 0) > 0);
    const taxableAmounts = lines.map((l, i) => (taxable[i] === true ? l.amountCents : 0));
    if (taxCents > 0 && !taxable.some(Boolean)) {
      return { ok: false, reason: 'This receipt shows GST, but no line is coded as having any.' };
    }
    if (taxCents === 0 && taxable.some(Boolean)) {
      return { ok: false, reason: 'A line is coded as having GST, but this receipt shows none.' };
    }
    return finish(taxCents === 0 ? lines.map(() => 0) : spread(taxableAmounts, taxCents), codes);
  }

  if (taxCents === 0) return finish(lines.map(() => 0), lines.map(() => 'P_FREE'));

  const printed = lines.map((l) => l.extractedTaxCents);
  if (printed.every((t): t is number => t !== null) && printed.reduce((s, t) => s + t, 0) === taxCents) {
    return finish(printed, printed.map((t) => (t > 0 ? 'P_GST' : 'P_FREE')));
  }

  // At 10%, GST is net / 10 or gross / 11. Each line can round by half a cent, so allow for that.
  const sum = lines.reduce((s, l) => s + l.amountCents, 0);
  const expected = inclusive ? sum / 11 : sum / 10;
  const tolerance = Math.max(1, lines.length / 2);
  if (Math.abs(taxCents - expected) <= tolerance) {
    return finish(spread(lines.map((l) => l.amountCents), taxCents), lines.map(() => 'P_GST'));
  }

  return { ok: false, reason: 'This receipt seems to mix taxable and GST-free items. Choose a GST code for each line.' };
}
