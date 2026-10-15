import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeDueDate } from '../utils/dueDate.js';
import type { PaymentTermRule } from '../types/accounting.js';

/**
 * Phase 43a — the due-date rule function, pure. The shared fixture is run by the
 * client's mirror too (client/src/__tests__/dueDate.test.ts), so the two
 * engines cannot drift apart.
 */

interface Case {
  rule: PaymentTermRule;
  n: number;
  date: string;
  expected: string;
}

// One copy, in the client package: Vite refuses to import files from outside
// its root, while node `fs` reads across the repo freely.
const cases = JSON.parse(
  readFileSync(new URL('../../../client/src/__tests__/fixtures/dueDateCases.json', import.meta.url), 'utf8'),
) as Case[];

describe('computeDueDate — shared fixture', () => {
  it.each(cases.map((c) => [`${c.rule} ${c.n} ${c.date}`, c] as const))('%s', (_name, c) => {
    expect(computeDueDate(c.rule, c.n, c.date)).toBe(c.expected);
  });
});
