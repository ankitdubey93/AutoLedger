import { describe, expect, it } from 'vitest';
import { parseFlexibleDate, type DateFormat } from '../utils/dateParse.js';

/** Unit tier — no database. */

describe('parseFlexibleDate', () => {
  const cases: Array<{ input: string; format: DateFormat; expected: string | null }> = [
    { input: '2026-03-09', format: 'ISO', expected: '2026-03-09' },
    { input: '2026/03/09', format: 'ISO', expected: '2026-03-09' },
    { input: '09/03/2026', format: 'DMY', expected: '2026-03-09' },
    { input: '09/03/2026', format: 'MDY', expected: '2026-09-03' },
    { input: '9.3.2026', format: 'DMY', expected: '2026-03-09' },
    { input: '09-03-26', format: 'DMY', expected: '2026-03-09' },
    { input: '09-03-89', format: 'DMY', expected: '1989-03-09' },
    { input: '2026-03-09', format: 'DMY', expected: '2026-03-09' },
    { input: '9 Mar 2026', format: 'ISO', expected: '2026-03-09' },
    { input: '09-MAR-2026', format: 'DMY', expected: '2026-03-09' },
    { input: 'Mar 9, 2026', format: 'MDY', expected: '2026-03-09' },
    { input: '31/02/2026', format: 'DMY', expected: null },
    { input: '29/02/2024', format: 'DMY', expected: '2024-02-29' },
    { input: '29/02/2026', format: 'DMY', expected: null },
    { input: '13/13/2026', format: 'DMY', expected: null },
    { input: '09/03/2026', format: 'ISO', expected: null },
    { input: '', format: 'ISO', expected: null },
    { input: '  ', format: 'DMY', expected: null },
    { input: 'n/a', format: 'MDY', expected: null },
  ];

  for (const { input, format, expected } of cases) {
    it(`parses "${input}" under ${format} as ${expected === null ? 'null' : `"${expected}"`}`, () => {
      expect(parseFlexibleDate(input, format)).toBe(expected);
    });
  }
});
