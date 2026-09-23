import { describe, expect, it } from 'vitest';
import { averageUnitCostCents, outflowValueCents, receiptValueCents } from '../utils/stockValuation.js';
import { isValidGtin } from '../utils/gtin.js';
import { ApiError } from '../utils/apiError.js';

/** StockLedger (Phase 28) — valuation arithmetic and the GTIN check digit. Pure unit tier. */

describe('receiptValueCents', () => {
  it('receipt 2.5 units at 199 cents = 498', () => {
    expect(receiptValueCents(199, 2500)).toBe(498);
  });

  it('large values do not lose precision', () => {
    // Finding from execution (Step 5): at the schema's declared caps
    // (unitCostCents up to 1e11, quantityMilli up to 1e9 — see
    // stock_movements' CHECK constraints in migration 067), the exact
    // product exceeds Number.MAX_SAFE_INTEGER by roughly 11x before the
    // final /1000. scaleCents's own safe-integer check (money.ts) is what
    // catches this — it throws rather than silently losing precision, which
    // is the correct behavior per guardrails rule 3. Per this step's own
    // contingency clause, the helper is NOT changed and the column caps are
    // NOT raised to work around it; the ceiling on a *realistic* unit cost
    // (a few million cents) is far below where this bites.
    expect(() => receiptValueCents(99_999_999_999, 1_000_000_000)).toThrow(ApiError);
  });
});

describe('outflowValueCents', () => {
  it('full outflow takes whole value', () => {
    expect(outflowValueCents(3000, 1000, 3000)).toBe(1000);
  });

  it('partial outflow half-up', () => {
    expect(outflowValueCents(3000, 1000, 1000)).toBe(333);
  });

  it('two partial outflows then the rest sum to the original value', () => {
    const first = outflowValueCents(3000, 1000, 1000);
    expect(first).toBe(333);

    const second = outflowValueCents(2000, 1000 - first, 1000);
    expect(second).toBe(334);

    const third = outflowValueCents(1000, 1000 - first - second, 1000);
    expect(third).toBe(333);

    expect(first + second + third).toBe(1000);
  });

  it('outflow above balance throws', () => {
    expect(() => outflowValueCents(1000, 500, 1001)).toThrow('outflow exceeds balance');
  });
});

describe('averageUnitCostCents', () => {
  it('average of empty balance is null', () => {
    expect(averageUnitCostCents(0, 0)).toBeNull();
  });

  it('computes a half-up per-unit cost', () => {
    expect(averageUnitCostCents(3000, 1000)).toBe(333);
  });
});

describe('isValidGtin', () => {
  it('valid EAN-13', () => {
    expect(isValidGtin('4006381333931')).toBe(true);
  });

  it('valid UPC-A', () => {
    expect(isValidGtin('036000291452')).toBe(true);
  });

  it('bad check digit', () => {
    expect(isValidGtin('4006381333932')).toBe(false);
  });

  it('wrong length', () => {
    expect(isValidGtin('12345')).toBe(false);
  });

  it('rejects non-digit characters', () => {
    expect(isValidGtin('40063813339X1')).toBe(false);
  });
});
