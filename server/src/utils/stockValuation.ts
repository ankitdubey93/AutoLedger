import { cents, scaleCents } from './money.js';

/**
 * Inventory (Phase 28) — perpetual-inventory valuation arithmetic. Every
 * function goes through `scaleCents(cents(x), n, d)`; none does its own
 * multiplication or division on a raw `number` (guardrails rule 3). See
 * `utils/money.ts` for why the scaling itself is BigInt-exact.
 */

/**
 * Value of receiving `quantityMilli` thousandths of a unit at `unitCostCents`
 * per whole unit (1000 milli). Rounds half away from zero (money.ts).
 */
export function receiptValueCents(unitCostCents: number, quantityMilli: number): number {
  return scaleCents(cents(unitCostCents), quantityMilli, 1000);
}

/**
 * Moving-average value leaving a balance of `balanceQuantityMilli` /
 * `balanceValueCents` when `outQuantityMilli` goes out.
 *
 * Taking the WHOLE remaining quantity takes the WHOLE remaining value —
 * never a proportional calculation for that case — so a sequence of partial
 * outflows that empties a balance always sums to exactly the balance's
 * original value, with no cent ever stranded by rounding.
 */
export function outflowValueCents(
  balanceQuantityMilli: number,
  balanceValueCents: number,
  outQuantityMilli: number,
): number {
  if (outQuantityMilli > balanceQuantityMilli) {
    throw new Error('outflow exceeds balance');
  }
  if (outQuantityMilli === balanceQuantityMilli) return balanceValueCents;
  return scaleCents(cents(balanceValueCents), outQuantityMilli, balanceQuantityMilli);
}

/** Per-unit cost (per 1000 milli), half-up; null when the balance is empty. */
export function averageUnitCostCents(quantityMilli: number, valueCents: number): number | null {
  if (quantityMilli === 0) return null;
  return scaleCents(cents(valueCents), 1000, quantityMilli);
}
