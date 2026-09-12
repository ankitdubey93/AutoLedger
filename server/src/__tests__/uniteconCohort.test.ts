import { describe, expect, it } from 'vitest';
import { buildCohortMatrix } from '../utils/uniteconCohort.js';
import type { CustomerRevenueFact } from '../types/unitecon.js';

/**
 * Unit tier — no database. buildCohortMatrix is a pure function; every
 * expected value below is hand-computed.
 */

const MONTHS = ['2026-01-01', '2026-02-01', '2026-03-01'];

function fact(customerId: string, month: string, netRevenueCents: number, customerName = customerId): CustomerRevenueFact {
  return { customerId, customerName, month, netRevenueCents };
}

describe('buildCohortMatrix', () => {
  it('returns an empty matrix for empty input', () => {
    const matrix = buildCohortMatrix([], MONTHS);
    expect(matrix.rows).toEqual([]);
    expect(matrix.totalNewCustomers).toBe(0);
    expect(matrix.excludedPriorCustomers).toBe(0);
    expect(matrix.months).toEqual(MONTHS);
  });

  it('one customer, one month', () => {
    const facts = [fact('c1', '2026-01-01', 50000)];
    const matrix = buildCohortMatrix(facts, MONTHS);

    expect(matrix.rows).toHaveLength(1);
    const row = matrix.rows[0]!;
    expect(row.cohortMonth).toBe('2026-01-01');
    expect(row.cohortSize).toBe(1);
    expect(row.cells).toHaveLength(3);
    expect(row.cells[0]).toEqual({
      offset: 0,
      month: '2026-01-01',
      activeCustomers: 1,
      netRevenueCents: 50000,
      retentionBps: 10000,
    });
    expect(row.cells[1]?.activeCustomers).toBe(0);
    expect(row.cells[1]?.retentionBps).toBe(0);
  });

  it('produces a triangular shape across three acquisition months', () => {
    const facts = [
      fact('c1', '2026-01-01', 100),
      fact('c2', '2026-02-01', 100),
      fact('c3', '2026-03-01', 100),
    ];
    const matrix = buildCohortMatrix(facts, MONTHS);

    const jan = matrix.rows.find((r) => r.cohortMonth === '2026-01-01')!;
    const feb = matrix.rows.find((r) => r.cohortMonth === '2026-02-01')!;
    const mar = matrix.rows.find((r) => r.cohortMonth === '2026-03-01')!;

    expect(jan.cells).toHaveLength(3);
    expect(feb.cells).toHaveLength(2);
    expect(mar.cells).toHaveLength(1);
  });

  it('rounds retention basis points half away from zero', () => {
    const facts = [
      fact('c1', '2026-01-01', 100),
      fact('c2', '2026-01-01', 100),
      fact('c3', '2026-01-01', 100),
      // Only c1 and c2 active in February.
      fact('c1', '2026-02-01', 50),
      fact('c2', '2026-02-01', 50),
    ];
    const matrix = buildCohortMatrix(facts, MONTHS);
    const row = matrix.rows[0]!;
    // 2/3 * 10000 = 6666.67 -> rounds to 6667.
    expect(row.cells[1]?.retentionBps).toBe(6667);
  });

  it('a zero-revenue fact does not acquire the customer', () => {
    const facts = [
      fact('c2', '2026-01-01', 0),
      fact('c2', '2026-02-01', 40000),
    ];
    const matrix = buildCohortMatrix(facts, MONTHS);

    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0]?.cohortMonth).toBe('2026-02-01');
    expect(matrix.rows[0]?.customerIds).toEqual(['c2']);
  });

  it('a zero-revenue fact does not count as active but is still summed', () => {
    const facts = [
      fact('c1', '2026-01-01', 100),
      fact('c1', '2026-02-01', 0),
    ];
    const matrix = buildCohortMatrix(facts, MONTHS);
    const row = matrix.rows[0]!;
    expect(row.cells[1]?.activeCustomers).toBe(0);
    expect(row.cells[1]?.netRevenueCents).toBe(0);
  });

  it('excludes a customer whose first revenue predates the window', () => {
    const facts = [
      fact('c3', '2025-12-01', 10000),
      fact('c3', '2026-02-01', 70000),
    ];
    const matrix = buildCohortMatrix(facts, MONTHS);

    expect(matrix.excludedPriorCustomers).toBe(1);
    for (const row of matrix.rows) {
      expect(row.customerIds).not.toContain('c3');
      for (const cell of row.cells) {
        expect(cell.netRevenueCents).toBe(0);
      }
    }
  });

  it('silently drops a customer whose first revenue is after the window, without incrementing excludedPriorCustomers', () => {
    const facts = [fact('c9', '2026-04-01', 999)];
    const matrix = buildCohortMatrix(facts, MONTHS);

    expect(matrix.rows).toHaveLength(0);
    expect(matrix.excludedPriorCustomers).toBe(0);
  });

  it('sums revenue across multiple facts in one month for one customer, without double-counting active', () => {
    const facts = [
      fact('c1', '2026-01-01', 30000),
      fact('c1', '2026-01-01', 20000),
    ];
    const matrix = buildCohortMatrix(facts, MONTHS);
    const row = matrix.rows[0]!;
    expect(row.cells[0]?.netRevenueCents).toBe(50000);
    expect(row.cells[0]?.activeCustomers).toBe(1);
  });

  it('sorts customerIds ascending within a cohort', () => {
    const facts = [
      fact('c-z', '2026-01-01', 100),
      fact('c-a', '2026-01-01', 100),
      fact('c-m', '2026-01-01', 100),
    ];
    const matrix = buildCohortMatrix(facts, MONTHS);
    expect(matrix.rows[0]?.customerIds).toEqual(['c-a', 'c-m', 'c-z']);
  });
});
