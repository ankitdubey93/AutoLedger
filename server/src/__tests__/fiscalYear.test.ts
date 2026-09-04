import { describe, expect, it } from 'vitest';
import { fiscalPeriodRanges, fiscalYearBounds, monthBounds, monthsBackStart } from '../utils/fiscalYear.js';

/**
 * Unit tier — no database. Pins the date arithmetic that backs every dashboard
 * and onboarding window; an off-by-one here means a local-time `Date` parse
 * crept back in (see the file header on fiscalYear.ts).
 */

describe('fiscalYearBounds', () => {
  it('calendar-aligned year (Jan 1 start), evaluated mid-year', () => {
    expect(fiscalYearBounds(1, 1, '2026-09-02')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      label: 'FY 2026',
    });
  });

  it('April-start fiscal year, evaluated after the start month', () => {
    expect(fiscalYearBounds(4, 1, '2026-09-02')).toEqual({
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      label: 'FY 2026–27',
    });
  });

  it('April-start fiscal year, evaluated one day before the boundary', () => {
    expect(fiscalYearBounds(4, 1, '2026-03-31')).toEqual({
      startDate: '2025-04-01',
      endDate: '2026-03-31',
      label: 'FY 2025–26',
    });
  });

  it('April-start fiscal year, evaluated exactly on the boundary', () => {
    expect(fiscalYearBounds(4, 1, '2026-04-01')).toEqual({
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      label: 'FY 2026–27',
    });
  });

  it('March-start fiscal year spanning a leap-day February', () => {
    expect(fiscalYearBounds(3, 1, '2024-01-15')).toEqual({
      startDate: '2023-03-01',
      endDate: '2024-02-29',
      label: 'FY 2023–24',
    });
  });
});

describe('monthBounds', () => {
  it('bounds a short month correctly', () => {
    expect(monthBounds('2026-02-15')).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
  });
});

describe('monthsBackStart', () => {
  it('crosses a year boundary', () => {
    expect(monthsBackStart('2026-01-10', 6)).toBe('2025-08-01');
  });
});

describe('fiscalPeriodRanges', () => {
  it('calendar-aligned year (Jan 1 start) produces 12 calendar months', () => {
    const ranges = fiscalPeriodRanges(1, 1, '2026-06-15');
    expect(ranges).toHaveLength(12);
    expect(ranges[0]).toEqual({ periodNumber: 1, startsOn: '2026-01-01', endsOn: '2026-01-31' });
    expect(ranges[11]).toEqual({ periodNumber: 12, startsOn: '2026-12-01', endsOn: '2026-12-31' });
  });

  it('April-start fiscal year (day 1) spans into the next calendar year', () => {
    const ranges = fiscalPeriodRanges(4, 1, '2026-06-15');
    expect(ranges[0]).toEqual({ periodNumber: 1, startsOn: '2026-04-01', endsOn: '2026-04-30' });
    expect(ranges[11]).toEqual({ periodNumber: 12, startsOn: '2027-03-01', endsOn: '2027-03-31' });
  });

  it('a mid-month start day (April 6) agrees with fiscalYearBounds at the tail', () => {
    const ranges = fiscalPeriodRanges(4, 6, '2026-06-15');
    expect(ranges[0]).toEqual({ periodNumber: 1, startsOn: '2026-04-06', endsOn: '2026-05-05' });
    expect(ranges[11]!.endsOn).toBe('2027-04-05');
    expect(ranges[11]!.endsOn).toBe(fiscalYearBounds(4, 6, '2026-06-15').endDate);
  });

  it('is contiguous and non-overlapping across every adjacent pair', () => {
    const ranges = fiscalPeriodRanges(4, 6, '2026-06-15');
    for (let i = 1; i < ranges.length; i++) {
      const prevEnd = new Date(`${ranges[i - 1]!.endsOn}T00:00:00Z`).getTime();
      const nextStart = new Date(`${ranges[i]!.startsOn}T00:00:00Z`).getTime();
      expect(nextStart - prevEnd).toBe(86_400_000);
    }
  });
});
