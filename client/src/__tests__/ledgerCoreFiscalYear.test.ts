import { describe, expect, it } from 'vitest';
import { fiscalYearBounds } from '../Pages/ledger-core/fiscalYear';

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
