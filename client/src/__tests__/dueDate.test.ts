import { describe, expect, it } from 'vitest';
import fixtureText from './fixtures/dueDateCases.json?raw';
import { computeDueDate, type PaymentTermRule } from '../utils/dueDate';

/**
 * Phase 43a — the client's due-date engine must agree with the server's on
 * every case of the one shared fixture. It lives here because Vite refuses
 * to load files outside the client package; the server suite reads this same
 * file with `fs` (server/src/__tests__/dueDate.test.ts).
 */

interface Case {
  rule: PaymentTermRule;
  n: number;
  date: string;
  expected: string;
}

const cases = JSON.parse(fixtureText) as Case[];

describe('computeDueDate — shared fixture', () => {
  it.each(cases.map((c) => [`${c.rule} ${c.n} ${c.date}`, c] as const))('%s', (_name, c) => {
    expect(computeDueDate(c.rule, c.n, c.date)).toBe(c.expected);
  });
});
