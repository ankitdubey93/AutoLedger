import { describe, expect, it } from 'vitest';
import { decomposePvm } from '../utils/uniteconPvm.js';
import type { PvmReport, ProductLineSalesFact } from '../types/unitecon.js';

/**
 * Unit tier — no database. decomposePvm is a pure function; every expected
 * value below is hand-computed.
 */

function fact(id: string, quantityMilli: number, netRevenueCents: number, name = id): ProductLineSalesFact {
  return { productLineId: id, productLineName: name, unitLabel: 'unit', quantityMilli, netRevenueCents };
}

/** Every row's three components must sum to its total, and so must the
 *  report's totals — this holds by construction (mix is the residual), but
 *  it is asserted explicitly everywhere below rather than trusted blindly. */
function expectRowsTieOut(report: PvmReport): void {
  for (const row of report.rows) {
    expect(row.priceVarianceCents + row.volumeVarianceCents + row.mixVarianceCents).toBe(
      row.totalVarianceCents,
    );
  }
  expect(
    report.totals.priceVarianceCents + report.totals.volumeVarianceCents + report.totals.mixVarianceCents,
  ).toBe(report.totals.totalVarianceCents);
}

describe('decomposePvm', () => {
  it('both periods empty', () => {
    const report = decomposePvm([], []);
    expect(report.rows).toEqual([]);
    expect(report.totals).toEqual({
      baseNetCents: 0,
      compareNetCents: 0,
      priceVarianceCents: 0,
      volumeVarianceCents: 0,
      mixVarianceCents: 0,
      totalVarianceCents: 0,
    });
  });

  it('no change: all components zero', () => {
    const base = [fact('A', 10000, 100000)];
    const compare = [fact('A', 10000, 100000)];
    const report = decomposePvm(base, compare);

    const row = report.rows[0]!;
    expect(row.priceVarianceCents).toBe(0);
    expect(row.volumeVarianceCents).toBe(0);
    expect(row.mixVarianceCents).toBe(0);
    expect(row.totalVarianceCents).toBe(0);
    expectRowsTieOut(report);
  });

  it('pure price change (constant quantity, single product)', () => {
    const base = [fact('A', 10000, 100000)];
    const compare = [fact('A', 10000, 120000)];
    const report = decomposePvm(base, compare);

    const row = report.rows[0]!;
    expect(row.priceVarianceCents).toBe(20000);
    expect(row.volumeVarianceCents).toBe(0);
    expect(row.mixVarianceCents).toBe(0);
    expect(row.totalVarianceCents).toBe(20000);
    expectRowsTieOut(report);
  });

  it('pure volume change, single product (mix is always 0 with one product)', () => {
    const base = [fact('A', 10000, 100000)];
    const compare = [fact('A', 20000, 200000)];
    const report = decomposePvm(base, compare);

    const row = report.rows[0]!;
    expect(row.priceVarianceCents).toBe(0);
    expect(row.volumeVarianceCents).toBe(100000);
    expect(row.mixVarianceCents).toBe(0);
    expect(row.totalVarianceCents).toBe(100000);
    expectRowsTieOut(report);
  });

  it('pure mix: two products, constant total volume, constant unit prices', () => {
    const base = [fact('A', 10000, 100000), fact('B', 10000, 200000)];
    const compare = [fact('A', 5000, 50000), fact('B', 15000, 300000)];
    const report = decomposePvm(base, compare);

    expect(report.totals.priceVarianceCents).toBe(0);
    expect(report.totals.volumeVarianceCents).toBe(0);
    expect(report.totals.totalVarianceCents).toBe(50000);
    // The two rows' mix sums to the total.
    const mixSum = report.rows.reduce((s, r) => s + r.mixVarianceCents, 0);
    expect(mixSum).toBe(50000);
    expectRowsTieOut(report);
  });

  it('a new product (absent from base) is pure mix', () => {
    const base = [fact('A', 10000, 100000)];
    const compare = [fact('A', 10000, 100000), fact('B', 4000, 40000)];
    const report = decomposePvm(base, compare);

    const rowB = report.rows.find((r) => r.productLineId === 'B')!;
    expect(rowB.priceVarianceCents).toBe(0);
    expect(rowB.volumeVarianceCents).toBe(0);
    expect(rowB.mixVarianceCents).toBe(40000);
    expectRowsTieOut(report);
  });

  it('a discontinued product (absent from compare) still ties out', () => {
    const base = [fact('A', 10000, 100000), fact('B', 4000, 40000)];
    const compare = [fact('A', 10000, 100000)];
    const report = decomposePvm(base, compare);

    const rowB = report.rows.find((r) => r.productLineId === 'B')!;
    expect(rowB.totalVarianceCents).toBe(-40000);
    expectRowsTieOut(report);
  });

  it('Q0 = 0: base period sold nothing, whole variance is mix', () => {
    const base: ProductLineSalesFact[] = [];
    const compare = [fact('A', 1000, 12345)];
    const report = decomposePvm(base, compare);

    const row = report.rows[0]!;
    expect(row.priceVarianceCents).toBe(0);
    expect(row.volumeVarianceCents).toBe(0);
    expect(row.mixVarianceCents).toBe(12345);
    expectRowsTieOut(report);
  });

  it('unit price is per whole unit, not per milli-unit', () => {
    const base = [fact('A', 2500, 25000)]; // 2.5 units @ 100.00 each
    const report = decomposePvm(base, base);
    expect(report.rows[0]?.baseUnitPriceCents).toBe(10000);
  });

  it('rounding is exact and never drifts on an awkward split', () => {
    const base = [fact('A', 3000, 10000), fact('B', 7000, 23333)];
    const compare = [fact('A', 7000, 23333), fact('B', 3000, 10000)];
    const report = decomposePvm(base, compare);
    expectRowsTieOut(report);
    // Aggregate totals must also match the raw sums exactly.
    expect(report.totals.baseNetCents).toBe(33333);
    expect(report.totals.compareNetCents).toBe(33333);
  });
});
