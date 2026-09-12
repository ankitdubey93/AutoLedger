import type { PvmReport, PvmRow, PvmTotals, ProductLineSalesFact } from '../types/unitecon.js';

/**
 * UnitEcon (Phase 14) — Price-Volume-Mix variance decomposition. A pure
 * function of its arguments: no database import, no clock, no I/O. Mirrors
 * the posture `utils/forecasterBuild.ts` and `utils/uniteconCohort.ts`
 * established.
 *
 * THE ARITHMETIC. Let q0/n0 be a product's base-period quantity-milli and net
 * cents, q1/n1 its comparison-period values, Q0 = sum(q0), Q1 = sum(q1) over
 * all products in the report.
 *
 *   totalVariance_p = n1 - n0
 *   price_p  = n1 - round(q1 * n0 / q0)          (0 when q0 = 0)
 *   volume_p = round(n0 * (Q1 - Q0) / Q0)         (0 when Q0 = 0 or q0 = 0)
 *   mix_p    = totalVariance_p - price_p - volume_p   <- always the residual
 *
 * This is algebraically exact: with p0 = n0/q0, the textbook components are
 * q1*(p1-p0), (Q1-Q0)*(q0/Q0)*p0 and (q1 - Q1*q0/Q0)*p0; substituting
 * p0 = n0/q0 cancels q0 out of the volume term entirely and the three sum to
 * n1 - n0 exactly. Assigning the residual to mix (decision D14) removes the
 * rounding drift that would otherwise appear from rounding price and volume
 * independently, without changing which product carries which effect.
 *
 * EDGE CASES:
 *  - A product present only in the comparison period (q0 = 0): price = 0,
 *    volume = 0, so the WHOLE variance is mix — a product that did not exist
 *    in the base period is pure mix, by definition.
 *  - A product present only in the base period (q1 = 0, n1 = 0): the general
 *    formulas apply unchanged, no special case.
 *  - Q0 = 0 (the base period sold nothing at all): price and volume are zero
 *    for every row and the whole variance is mix.
 */

/** Exact integer division rounding half away from zero. `d` must be > 0n. */
function divRound(n: bigint, d: bigint): bigint {
  const magnitude = (n < 0n ? -n : n) * 2n + d;
  const half = magnitude / (2n * d);
  return n < 0n ? -half : half;
}

function collapse(facts: readonly ProductLineSalesFact[]): Map<string, ProductLineSalesFact> {
  const byLine = new Map<string, ProductLineSalesFact>();
  for (const fact of facts) {
    byLine.set(fact.productLineId, fact);
  }
  return byLine;
}

export function decomposePvm(
  base: readonly ProductLineSalesFact[],
  compare: readonly ProductLineSalesFact[],
): PvmReport {
  const baseByLine = collapse(base);
  const compareByLine = collapse(compare);

  const Q0: bigint = base.reduce((sum, f) => sum + BigInt(f.quantityMilli), 0n);
  const Q1: bigint = compare.reduce((sum, f) => sum + BigInt(f.quantityMilli), 0n);

  const allIds = new Set<string>([...baseByLine.keys(), ...compareByLine.keys()]);

  const rows: PvmRow[] = [];

  for (const productLineId of allIds) {
    const baseFact = baseByLine.get(productLineId);
    const compareFact = compareByLine.get(productLineId);

    const q0 = BigInt(baseFact?.quantityMilli ?? 0);
    const n0 = BigInt(baseFact?.netRevenueCents ?? 0);
    const q1 = BigInt(compareFact?.quantityMilli ?? 0);
    const n1 = BigInt(compareFact?.netRevenueCents ?? 0);

    const totalVariance = n1 - n0;

    let price = 0n;
    let volume = 0n;
    if (q0 > 0n) {
      price = n1 - divRound(q1 * n0, q0);
      if (Q0 > 0n) {
        volume = divRound(n0 * (Q1 - Q0), Q0);
      }
    }
    const mix = totalVariance - price - volume;

    const baseUnitPriceCents = q0 === 0n ? 0 : Number(divRound(n0 * 1000n, q0));
    const compareUnitPriceCents = q1 === 0n ? 0 : Number(divRound(n1 * 1000n, q1));

    const productLineName = compareFact?.productLineName ?? baseFact?.productLineName ?? '';
    const unitLabel = compareFact?.unitLabel ?? baseFact?.unitLabel ?? '';

    rows.push({
      productLineId,
      productLineName,
      unitLabel,
      baseQuantityMilli: Number(q0),
      compareQuantityMilli: Number(q1),
      baseNetCents: Number(n0),
      compareNetCents: Number(n1),
      baseUnitPriceCents,
      compareUnitPriceCents,
      priceVarianceCents: Number(price),
      volumeVarianceCents: Number(volume),
      mixVarianceCents: Number(mix),
      totalVarianceCents: Number(totalVariance),
    });
  }

  rows.sort((a, b) =>
    a.productLineName < b.productLineName
      ? -1
      : a.productLineName > b.productLineName
        ? 1
        : a.productLineId < b.productLineId
          ? -1
          : a.productLineId > b.productLineId
            ? 1
            : 0,
  );

  const totals: PvmTotals = rows.reduce<PvmTotals>(
    (acc, row) => ({
      baseNetCents: acc.baseNetCents + row.baseNetCents,
      compareNetCents: acc.compareNetCents + row.compareNetCents,
      priceVarianceCents: acc.priceVarianceCents + row.priceVarianceCents,
      volumeVarianceCents: acc.volumeVarianceCents + row.volumeVarianceCents,
      mixVarianceCents: acc.mixVarianceCents + row.mixVarianceCents,
      totalVarianceCents: acc.totalVarianceCents + row.totalVarianceCents,
    }),
    {
      baseNetCents: 0,
      compareNetCents: 0,
      priceVarianceCents: 0,
      volumeVarianceCents: 0,
      mixVarianceCents: 0,
      totalVarianceCents: 0,
    },
  );

  return { rows, totals };
}
