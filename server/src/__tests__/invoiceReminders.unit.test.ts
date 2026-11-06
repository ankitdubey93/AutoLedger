import { describe, it, expect } from 'vitest';
import { reminderOffsetDue } from '../utils/invoiceReminders.js';

/**
 * Phase 48 — the pure reminder decision. `today` is passed explicitly; the
 * function never reads the clock.
 */
describe('reminderOffsetDue', () => {
  const offsets = [7, 14, 30];

  it('due 2026-03-01, today 2026-03-07, none sent → null (offset 7 not yet passed)', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-03-07', offsets, [])).toBeNull();
  });

  it('due 2026-03-01, today 2026-03-08, none sent → 7', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-03-08', offsets, [])).toBe(7);
  });

  it('due 2026-03-01, today 2026-03-08, sent [7] → null', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-03-08', offsets, [7])).toBeNull();
  });

  it('due 2026-03-01, today 2026-03-15, sent [7] → 14', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-03-15', offsets, [7])).toBe(14);
  });

  it('due 2026-03-01, today 2026-04-15, none sent → 30 (no back-fill of 7 or 14)', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-04-15', offsets, [])).toBe(30);
  });

  it('due 2026-03-01, today 2026-04-15, sent [30] → null', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-04-15', offsets, [30])).toBeNull();
  });

  it('negative offset [-3], due 2026-03-01, today 2026-02-26 → -3', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-02-26', [-3], [])).toBe(-3);
  });

  it('negative offset [-3], due 2026-03-01, today 2026-02-25 → null', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-02-25', [-3], [])).toBeNull();
  });

  it('crosses a leap day: due 2028-02-28, offset [1], today 2028-02-29 → 1', () => {
    expect(reminderOffsetDue('2028-02-28', '2028-02-29', [1], [])).toBe(1);
  });

  it('empty offsets → null', () => {
    expect(reminderOffsetDue('2026-03-01', '2026-04-15', [], [])).toBeNull();
  });
});
