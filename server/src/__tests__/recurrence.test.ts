import { describe, it, expect } from 'vitest';
import { addDays, firstDayOfNextMonth, occurrenceDate } from '../utils/recurrence.js';

describe('recurrence utilities', () => {
  it('index 0 is the start date', () => {
    expect(occurrenceDate('2026-01-31', 'MONTHLY', 1, 0)).toBe('2026-01-31');
  });

  it('monthly clamps to the end of a short month', () => {
    expect(occurrenceDate('2026-01-31', 'MONTHLY', 1, 1)).toBe('2026-02-28');
  });

  it('monthly returns to the anchor day after a short month', () => {
    expect(occurrenceDate('2026-01-31', 'MONTHLY', 1, 2)).toBe('2026-03-31');
  });

  it('monthly respects leap years', () => {
    expect(occurrenceDate('2024-01-31', 'MONTHLY', 1, 1)).toBe('2024-02-29');
  });

  it('weekly with interval 2', () => {
    expect(occurrenceDate('2026-01-15', 'WEEKLY', 2, 3)).toBe('2026-02-26');
  });

  it('quarterly crosses a year boundary and clamps', () => {
    expect(occurrenceDate('2026-11-30', 'QUARTERLY', 1, 1)).toBe('2027-02-28');
  });

  it('yearly from a leap day', () => {
    expect(occurrenceDate('2024-02-29', 'YEARLY', 1, 1)).toBe('2025-02-28');
  });

  it('a negative index throws', () => {
    expect(() => occurrenceDate('2026-01-01', 'MONTHLY', 1, -1)).toThrow(
      'occurrenceIndex must be a non-negative integer',
    );
  });

  it('firstDayOfNextMonth crosses the year', () => {
    expect(firstDayOfNextMonth('2026-12-15')).toBe('2027-01-01');
    expect(firstDayOfNextMonth('2026-01-31')).toBe('2026-02-01');
  });

  it('addDays crosses a month', () => {
    expect(addDays('2026-01-30', 5)).toBe('2026-02-04');
  });
});
