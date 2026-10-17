import { describe, expect, it } from 'vitest';
import { buildRatios, computeRatioValues, ratioBp } from '../utils/financialRatios.js';
import { SNAPSHOT_RATIO_KEYS } from '../types/accounting.js';
import type { SnapshotPerformance, SnapshotPosition } from '../types/accounting.js';

const performance: SnapshotPerformance = {
  revenueCents: 300000,
  costOfSalesCents: 120000,
  grossProfitCents: 180000,
  operatingExpensesCents: 100000,
  netIncomeCents: 80000,
};

const position: SnapshotPosition = {
  asOf: '2026-09-30',
  currentAssetsCents: 700000,
  nonCurrentAssetsCents: 500000,
  totalAssetsCents: 1200000,
  currentLiabilitiesCents: 120000,
  nonCurrentLiabilitiesCents: 400000,
  totalLiabilitiesCents: 520000,
  netWorthCents: 680000,
  workingCapitalCents: 580000,
};

describe('ratioBp', () => {
  it('rounds 5.8333x to 58333 bp', () => {
    expect(ratioBp(700000, 120000)).toEqual({ valueBp: 58333, reason: null });
  });
  it('rounds down below half', () => {
    expect(ratioBp(1, 3).valueBp).toBe(3333);
  });
  it('is exact when divisible', () => {
    expect(ratioBp(1, 8).valueBp).toBe(1250);
  });
  it('rounds 0.5 bp away from zero', () => {
    expect(ratioBp(1, 20000).valueBp).toBe(1);
  });
  it('rounds a negative 0.5 bp away from zero', () => {
    expect(ratioBp(-1, 20000).valueBp).toBe(-1);
  });
  it('normalises zero (no -0)', () => {
    expect(Object.is(ratioBp(0, 5).valueBp, 0)).toBe(true);
  });
  it('is unavailable on a zero denominator', () => {
    expect(ratioBp(5, 0)).toEqual({ valueBp: null, reason: 'DENOMINATOR_ZERO' });
  });
  it('is unavailable on a negative denominator', () => {
    expect(ratioBp(5, -3)).toEqual({ valueBp: null, reason: 'DENOMINATOR_NEGATIVE' });
  });
});

describe('computeRatioValues', () => {
  it('computes the seven ratios from the fixture', () => {
    const v = computeRatioValues(performance, position);
    expect(v.GROSS_MARGIN.valueBp).toBe(6000);
    expect(v.CURRENT_RATIO.valueBp).toBe(58333);
    expect(v.DEBT_RATIO.valueBp).toBe(4333);
    expect(v.DEBT_TO_EQUITY.valueBp).toBe(7647);
    expect(v.WORKING_CAPITAL_TO_TOTAL_ASSETS.valueBp).toBe(4833);
    expect(v.FIXED_ASSETS_TO_NET_WORTH.valueBp).toBe(7353);
    expect(v.CURRENT_LIABILITIES_TO_NET_WORTH.valueBp).toBe(1765);
  });
});

describe('buildRatios', () => {
  it('returns one entry per key in order', () => {
    const r = buildRatios({ performance, position }, { performance, position });
    expect(r).toHaveLength(7);
    expect(r.map((x) => x.key)).toEqual([...SNAPSHOT_RATIO_KEYS]);
    expect(r.find((x) => x.key === 'CURRENT_RATIO')?.kind).toBe('TIMES');
  });
});
