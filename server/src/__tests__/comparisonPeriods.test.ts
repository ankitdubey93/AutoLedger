import { describe, expect, it } from 'vitest';
import { addMonthsClamped, comparisonPeriods, isMonthAligned, variance } from '../utils/comparisonPeriods.js';

/** Unit tier — no database. Calendar facts: month-end clamping and leap days. */

describe('comparisonPeriods', () => {
  it('1. MoM with two prior months', () => {
    expect(comparisonPeriods('2026-10-01', '2026-10-31', 'previousPeriod', 2)).toEqual([
      { from: '2026-10-01', to: '2026-10-31', label: 'Oct 2026' },
      { from: '2026-09-01', to: '2026-09-30', label: 'Sep 2026' },
      { from: '2026-08-01', to: '2026-08-31', label: 'Aug 2026' },
    ]);
  });

  it('2. QoQ shifts by the three-month span', () => {
    const periods = comparisonPeriods('2026-07-01', '2026-09-30', 'previousPeriod', 1);
    expect(periods[0]?.label).toBe('Jul–Sep 2026');
    expect(periods[1]).toEqual({ from: '2026-04-01', to: '2026-06-30', label: 'Apr–Jun 2026' });
  });

  it('3. March → February ends on the 28th', () => {
    const periods = comparisonPeriods('2026-03-01', '2026-03-31', 'previousPeriod', 1);
    expect(periods[1]).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('4. March → February ends on the 29th in a leap year', () => {
    const periods = comparisonPeriods('2024-03-01', '2024-03-31', 'previousPeriod', 1);
    expect(periods[1]).toMatchObject({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('5. same period last year, month-aligned', () => {
    const periods = comparisonPeriods('2026-10-01', '2026-10-31', 'samePeriodLastYear', 2);
    expect(periods[1]).toMatchObject({ from: '2025-10-01', to: '2025-10-31' });
    expect(periods[2]).toMatchObject({ from: '2024-10-01', to: '2024-10-31' });
  });

  it('6. February same-period picks up the leap day two years back', () => {
    const periods = comparisonPeriods('2026-02-01', '2026-02-28', 'samePeriodLastYear', 2);
    expect(periods[1]).toMatchObject({ from: '2025-02-01', to: '2025-02-28' });
    expect(periods[2]).toMatchObject({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('7. a leap day clamps to 28 February', () => {
    const periods = comparisonPeriods('2024-02-29', '2024-02-29', 'samePeriodLastYear', 1);
    expect(periods[1]).toMatchObject({ from: '2023-02-28', to: '2023-02-28' });
  });

  it('8. a non-aligned range shifts by its day count', () => {
    const periods = comparisonPeriods('2026-10-05', '2026-10-14', 'previousPeriod', 1);
    expect(periods[1]).toEqual({ from: '2026-09-25', to: '2026-10-04', label: '2026-09-25–2026-10-04' });
  });

  it('9. a cross-year quarter is labelled with both years', () => {
    const periods = comparisonPeriods('2025-11-01', '2026-01-31', 'previousPeriod', 1);
    expect(periods[0]?.label).toBe('Nov 2025–Jan 2026');
    expect(periods[1]).toEqual({ from: '2025-08-01', to: '2025-10-31', label: 'Aug–Oct 2025' });
  });

  it('10. count outside 1..11 throws RangeError', () => {
    expect(() => comparisonPeriods('2026-10-01', '2026-10-31', 'previousPeriod', 0)).toThrow(RangeError);
    expect(() => comparisonPeriods('2026-10-01', '2026-10-31', 'previousPeriod', 12)).toThrow(RangeError);
  });

  it('11. variance in cents and basis points', () => {
    expect(variance(15000, 10000)).toEqual({ cents: 5000, bp: 5000 });
    expect(variance(5000, -10000)).toEqual({ cents: 15000, bp: 15000 });
    expect(variance(100, 0)).toEqual({ cents: 100, bp: null });
    expect(variance(1, 3)).toEqual({ cents: -2, bp: -6667 });
  });

  it('helpers', () => {
    expect(isMonthAligned('2026-02-01', '2026-02-28')).toBe(true);
    expect(isMonthAligned('2026-02-01', '2026-02-27')).toBe(false);
    expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonthsClamped('2024-02-29', -12)).toBe('2023-02-28');
  });
});
