import { describe, expect, it } from 'vitest';
import { sectionOf, summarizeVariance } from '../utils/boarddeckVariance.js';
import type { ForecasterVarianceRow } from '../types/forecaster.js';

/**
 * BoardDeck's boarddeckVariance engine (Phase 15). Pure unit tests — no
 * Postgres, no fixtures — mirroring uniteconPvm.test.ts's posture.
 */

function row(overrides: Partial<ForecasterVarianceRow>): ForecasterVarianceRow {
  return {
    accountId: 'acct-1',
    accountCode: '6100',
    accountName: 'Office Supplies',
    accountType: 'Expense',
    month: '2026-06-01',
    budgetCents: 0,
    actualCents: 0,
    varianceCents: 0,
    favourable: true,
    ...overrides,
  };
}

describe('sectionOf', () => {
  it('a 5xxx Expense account lands in Cost of Sales', () => {
    expect(sectionOf('Expense', '5100')).toBe('Cost of Sales');
  });

  it('a 6xxx Expense account lands in Operating Expenses', () => {
    expect(sectionOf('Expense', '6200')).toBe('Operating Expenses');
  });

  it('an Asset account lands in Other', () => {
    expect(sectionOf('Asset', '1100')).toBe('Other');
  });
});

describe('summarizeVariance', () => {
  it('months collapse into one bucket per account', () => {
    const rows = [
      row({ accountId: 'a1', accountCode: '6100', month: '2026-06-01', budgetCents: 1000, actualCents: 900 }),
      row({ accountId: 'a1', accountCode: '6100', month: '2026-07-01', budgetCents: 2000, actualCents: 1800 }),
      row({ accountId: 'a1', accountCode: '6100', month: '2026-08-01', budgetCents: 3000, actualCents: 2700 }),
    ];
    const result = summarizeVariance(rows, 5);
    expect(result.drivers).toHaveLength(1);
    expect(result.drivers[0]?.budgetCents).toBe(6000);
    expect(result.drivers[0]?.actualCents).toBe(5400);
  });

  it('revenue above budget is favourable, expense above budget is not', () => {
    const rows = [
      row({ accountId: 'rev', accountCode: '4100', accountType: 'Revenue', budgetCents: 1000, actualCents: 1200 }),
      row({ accountId: 'exp', accountCode: '6100', accountType: 'Expense', budgetCents: 1000, actualCents: 1200 }),
    ];
    const result = summarizeVariance(rows, 5);
    const rev = result.drivers.find((d) => d.accountId === 'rev');
    const exp = result.drivers.find((d) => d.accountId === 'exp');
    expect(rev?.favourable).toBe(true);
    expect(exp?.favourable).toBe(false);
  });

  it('a zero variance is favourable in both directions', () => {
    const rows = [
      row({ accountId: 'rev', accountCode: '4100', accountType: 'Revenue', budgetCents: 1000, actualCents: 1000 }),
      row({ accountId: 'exp', accountCode: '6100', accountType: 'Expense', budgetCents: 1000, actualCents: 1000 }),
    ];
    const result = summarizeVariance(rows, 5);
    expect(result.drivers.every((d) => d.favourable)).toBe(true);
  });

  it('all four sections are present even with no activity', () => {
    const rows = [row({ accountId: 'rev', accountCode: '4100', accountType: 'Revenue', budgetCents: 1000, actualCents: 1000 })];
    const result = summarizeVariance(rows, 5);
    expect(result.sections.map((s) => s.section)).toEqual([
      'Revenue',
      'Cost of Sales',
      'Operating Expenses',
      'Other',
    ]);
  });

  it('section variances sum exactly to the total', () => {
    const rows = [
      row({ accountId: 'rev', accountCode: '4100', accountType: 'Revenue', budgetCents: 10_000, actualCents: 12_345 }),
      row({ accountId: 'cogs', accountCode: '5100', accountType: 'Expense', budgetCents: 5_000, actualCents: 4_321 }),
      row({ accountId: 'opex', accountCode: '6100', accountType: 'Expense', budgetCents: 3_000, actualCents: 3_777 }),
      row({ accountId: 'other', accountCode: '1100', accountType: 'Asset', budgetCents: 100, actualCents: 250 }),
    ];
    const result = summarizeVariance(rows, 5);
    const sectionSum = result.sections.reduce((sum, s) => sum + s.varianceCents, 0);
    expect(sectionSum).toBe(result.totalVarianceCents);
  });

  it('drivers are ordered by absolute variance descending and truncated to topN', () => {
    const rows = [
      row({ accountId: 'a', accountCode: '6100', budgetCents: 0, actualCents: 100 }),
      row({ accountId: 'b', accountCode: '6200', budgetCents: 0, actualCents: 500 }),
      row({ accountId: 'c', accountCode: '6300', budgetCents: 0, actualCents: 50 }),
      row({ accountId: 'd', accountCode: '6400', budgetCents: 0, actualCents: 300 }),
      row({ accountId: 'e', accountCode: '6500', budgetCents: 0, actualCents: 10 }),
    ];
    const result = summarizeVariance(rows, 3);
    expect(result.drivers.map((d) => d.accountCode)).toEqual(['6200', '6400', '6100']);
  });

  it('topN of 0 returns no drivers', () => {
    const rows = [row({ accountId: 'a', accountCode: '6100', budgetCents: 0, actualCents: 100 })];
    const result = summarizeVariance(rows, 0);
    expect(result.drivers).toHaveLength(0);
  });
});
