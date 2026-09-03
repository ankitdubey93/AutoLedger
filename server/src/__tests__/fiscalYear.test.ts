import { describe, expect, it } from 'vitest';
import { fiscalYearBounds, monthBounds, monthsBackStart } from '../utils/fiscalYear.js';

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
