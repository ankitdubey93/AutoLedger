import { describe, expect, it } from 'vitest';
import cases from '../../../client/src/__tests__/fixtures/lineTaxCases.json' with { type: 'json' };
import { computeLineTotals, type TaxMode } from '../utils/documentTotals.js';

describe('computeLineTotals matches the shared fixture (Phase 49b)', () => {
  it.each(cases)('$unitPriceCents x $quantityMilli at $taxRateBp bp, $mode', (c) => {
    const [total] = computeLineTotals(
      [{ unitPriceCents: c.unitPriceCents, quantityMilli: c.quantityMilli, taxRateBp: c.taxRateBp }],
      c.mode as TaxMode,
    );
    expect({ netCents: total?.netCents, taxCents: total?.taxCents }).toEqual({ netCents: c.netCents, taxCents: c.taxCents });
  });
});
