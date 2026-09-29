import { describe, expect, it } from 'vitest';
import { formatDate } from '../utils/date';

describe('formatDate', () => {
  it('keeps the calendar day, whatever the machine timezone', () => {
    // `new Date('2026-01-01')` is UTC midnight — in local time west of UTC
    // that is 31 Dec. The helper formats in UTC, so the day never shifts.
    const expected = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
      Date.UTC(2026, 0, 1),
    );
    expect(formatDate('2026-01-01')).toBe(expected);
    expect(formatDate('2026-01-01')).toContain('2026');
    expect(formatDate('2026-01-01')).not.toContain('2025');
  });

  it('passes through anything that is not a plain date, and dashes a missing one', () => {
    expect(formatDate('2026-09-29T10:00:00Z')).toBe('2026-09-29T10:00:00Z');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('')).toBe('—');
  });
});
