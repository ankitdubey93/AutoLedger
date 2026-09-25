/**
 * Pure, immutable bank rule matching — no side effects, no database access.
 * Phase 34a.
 *
 * The matcher finds the highest-priority rule matching a bank line's conditions.
 * Priority is tiebroken by creation date (older wins).
 */

export interface BankRuleForMatch {
  id: string;
  priority: number;
  createdAt: string; // ISO timestamp, tie-break only
  direction: 'IN' | 'OUT' | 'ANY';
  memoContains: string;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  bankAccountId: string | null;
}

export interface BankLineForMatch {
  description: string;
  amountCents: number; // signed: > 0 money in, < 0 money out
  accountId: string;
}

/**
 * Lowercase, trim, and collapse every whitespace run to one space.
 */
export function normalizeMemo(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * The first rule, ordered by priority ASC then createdAt ASC, that matches every condition:
 * bankAccountId null or equal to line.accountId; direction ANY, or IN with amountCents > 0,
 * or OUT with amountCents < 0; normalizeMemo(line.description) contains normalizeMemo(memoContains);
 * |amountCents| >= amountMinCents when set and <= amountMaxCents when set.
 * A zero-amount line never matches. Sorts a copy — never mutates `rules`. Returns null when none match.
 */
export function findMatchingRule<R extends BankRuleForMatch>(
  line: BankLineForMatch,
  rules: readonly R[],
): R | null {
  // A zero-amount line never matches.
  if (line.amountCents === 0) {
    return null;
  }

  // Sort a copy by priority ASC, then createdAt ASC.
  const sorted = [...rules].sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });

  const normalizedLineDescription = normalizeMemo(line.description);

  for (const rule of sorted) {
    // Bank account check: null = applies to every bank account, or equal to line's account.
    if (rule.bankAccountId !== null && rule.bankAccountId !== line.accountId) {
      continue;
    }

    // Direction check: ANY matches all, IN requires > 0, OUT requires < 0.
    if (rule.direction === 'IN' && line.amountCents <= 0) {
      continue;
    }
    if (rule.direction === 'OUT' && line.amountCents >= 0) {
      continue;
    }

    // Memo substring check: case-insensitive, normalized whitespace.
    const normalizedRuleMemo = normalizeMemo(rule.memoContains);
    if (!normalizedLineDescription.includes(normalizedRuleMemo)) {
      continue;
    }

    // Amount bounds check: compare absolute value, inclusive.
    const absoluteAmount = Math.abs(line.amountCents);
    if (rule.amountMinCents !== null && absoluteAmount < rule.amountMinCents) {
      continue;
    }
    if (rule.amountMaxCents !== null && absoluteAmount > rule.amountMaxCents) {
      continue;
    }

    // All conditions met.
    return rule;
  }

  return null;
}
