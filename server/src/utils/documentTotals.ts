import { cents, scaleCents, sumCents, type Cents } from './money.js';

/**
 * Line and header totals for every priced sales/purchase document — invoices,
 * bills, credit notes, debit notes and quotes (Phase 41). One implementation,
 * so the rounding rule cannot drift between documents that later convert into
 * one another (a quote's total must equal the invoice it becomes).
 *
 * Tax is computed per line and then summed — never on the subtotal — so a
 * mixed-rate document is correct and the stored line values reconcile to the
 * header exactly, which each table's `chk_*_total` CHECK asserts.
 */

/** Phase 49b — whether a line's price already includes tax. Every other mode of arithmetic follows from this. */
export type TaxMode = 'EXCLUSIVE' | 'INCLUSIVE';

export interface PricedLine {
  unitPriceCents: number;
  /** Quantity in thousandths (1.5 units = 1500). */
  quantityMilli: number;
  /** Basis points (15% = 1500). */
  taxRateBp: number;
}

export interface LineTotal<T extends PricedLine> {
  input: T;
  netCents: number;
  taxCents: number;
}

export interface DocumentTotals {
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

/**
 * Exclusive: tax is added to the price. Inclusive: the price already holds it,
 * so tax = gross x rate / (1 + rate) and net is the rest, which at 10% is the
 * familiar "divide by 11". Net is derived by subtraction so net + tax always
 * equals what the customer pays, whatever the rounding did.
 */
export function computeLineTotals<T extends PricedLine>(lines: readonly T[], mode: TaxMode = 'EXCLUSIVE'): LineTotal<T>[] {
  return lines.map((line) => {
    const amount = scaleCents(cents(line.unitPriceCents), line.quantityMilli, 1000);
    if (mode === 'INCLUSIVE') {
      const taxCents = scaleCents(amount, line.taxRateBp, 10000 + line.taxRateBp);
      return { input: line, netCents: amount - taxCents, taxCents };
    }
    return { input: line, netCents: amount, taxCents: scaleCents(amount, line.taxRateBp, 10000) };
  });
}

export function sumDocumentTotals(totals: readonly { netCents: number; taxCents: number }[]): DocumentTotals {
  const subtotalCents = sumCents(totals.map((t) => cents(t.netCents)));
  const taxCents = sumCents(totals.map((t) => cents(t.taxCents)));
  return { subtotalCents, taxCents, totalCents: cents(subtotalCents + taxCents) };
}
