/**
 * Phase 49b — a line's net and tax, mirroring the server's
 * utils/documentTotals.ts. Kept in parity by fixtures/lineTaxCases.json, which
 * both test suites run. Display only: the server always recomputes.
 */
export type TaxMode = 'EXCLUSIVE' | 'INCLUSIVE';

function divideRounded(numerator: number, denominator: number): number {
  return Math.round(numerator / denominator);
}

export function lineAmounts(
  unitPriceCents: number,
  quantityMilli: number,
  taxRateBp: number,
  mode: TaxMode = 'EXCLUSIVE',
): { netCents: number; taxCents: number } {
  const amount = divideRounded(unitPriceCents * quantityMilli, 1000);
  if (mode === 'INCLUSIVE') {
    const taxCents = divideRounded(amount * taxRateBp, 10000 + taxRateBp);
    return { netCents: amount - taxCents, taxCents };
  }
  return { netCents: amount, taxCents: divideRounded(amount * taxRateBp, 10000) };
}
