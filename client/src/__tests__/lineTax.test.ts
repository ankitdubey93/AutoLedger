import { describe, expect, it } from 'vitest';
import cases from './fixtures/lineTaxCases.json';
import { lineAmounts, type TaxMode } from '../utils/lineTax';

describe('lineAmounts mirrors the server (Phase 49b)', () => {
  it.each(cases)('$unitPriceCents x $quantityMilli at $taxRateBp bp, $mode', (c) => {
    expect(lineAmounts(c.unitPriceCents, c.quantityMilli, c.taxRateBp, c.mode as TaxMode)).toEqual({
      netCents: c.netCents,
      taxCents: c.taxCents,
    });
  });
});
