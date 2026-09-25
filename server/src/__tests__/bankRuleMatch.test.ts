import { describe, it, expect } from 'vitest';
import {
  normalizeMemo,
  findMatchingRule,
  type BankRuleForMatch,
  type BankLineForMatch,
} from '../utils/bankRuleMatch.js';

describe('bankRuleMatch', () => {
  it('matches a case-insensitive substring after whitespace normalisation', () => {
    // Verify normalizeMemo normalizes correctly
    expect(normalizeMemo('stripe  fee')).toBe('stripe fee');
    expect(normalizeMemo('STRIPE  FEE')).toBe('stripe fee');

    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-1',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'stripe  fee',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
    ];

    const line: BankLineForMatch = {
      description: 'PAYOUT STRIPE FEE 0923',
      amountCents: -500,
      accountId: 'acc-1',
    };

    const match = findMatchingRule(line, rules);
    expect(match?.id).toBe('rule-1');
  });

  it('direction IN ignores money out', () => {
    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-1',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'IN',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
    ];

    const line: BankLineForMatch = {
      description: 'test transaction',
      amountCents: -500,
      accountId: 'acc-1',
    };

    const match = findMatchingRule(line, rules);
    expect(match).toBeNull();
  });

  it('direction OUT matches money out', () => {
    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-1',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'OUT',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
    ];

    const line: BankLineForMatch = {
      description: 'test transaction',
      amountCents: -500,
      accountId: 'acc-1',
    };

    const match = findMatchingRule(line, rules);
    expect(match?.id).toBe('rule-1');
  });

  it('amount bounds are inclusive and compare the absolute value', () => {
    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-1',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: 500,
        amountMaxCents: 1000,
        bankAccountId: null,
      },
    ];

    // Test at min boundary
    let line: BankLineForMatch = {
      description: 'test transaction',
      amountCents: -500,
      accountId: 'acc-1',
    };
    expect(findMatchingRule(line, rules)?.id).toBe('rule-1');

    // Test at max boundary
    line = { description: 'test transaction', amountCents: 1000, accountId: 'acc-1' };
    expect(findMatchingRule(line, rules)?.id).toBe('rule-1');

    // Test above max
    line = { description: 'test transaction', amountCents: 1001, accountId: 'acc-1' };
    expect(findMatchingRule(line, rules)).toBeNull();

    // Test below min
    line = { description: 'test transaction', amountCents: -499, accountId: 'acc-1' };
    expect(findMatchingRule(line, rules)).toBeNull();
  });

  it('a rule scoped to another bank account never matches', () => {
    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-1',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: 'acc-2',
      },
    ];

    const line: BankLineForMatch = {
      description: 'test transaction',
      amountCents: 500,
      accountId: 'acc-1',
    };

    const match = findMatchingRule(line, rules);
    expect(match).toBeNull();
  });

  it('lower priority number wins', () => {
    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-200',
        priority: 200,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
      {
        id: 'rule-100',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
    ];

    const line: BankLineForMatch = {
      description: 'test transaction',
      amountCents: 500,
      accountId: 'acc-1',
    };

    const match = findMatchingRule(line, rules);
    expect(match?.id).toBe('rule-100');
  });

  it('equal priority falls back to the older rule', () => {
    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-newer',
        priority: 100,
        createdAt: '2026-01-02T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
      {
        id: 'rule-older',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
    ];

    const line: BankLineForMatch = {
      description: 'test transaction',
      amountCents: 500,
      accountId: 'acc-1',
    };

    const match = findMatchingRule(line, rules);
    expect(match?.id).toBe('rule-older');
  });

  it('a zero amount never matches', () => {
    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-1',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
    ];

    const line: BankLineForMatch = {
      description: 'test transaction',
      amountCents: 0,
      accountId: 'acc-1',
    };

    const match = findMatchingRule(line, rules);
    expect(match).toBeNull();
  });

  it('does not mutate the input array', () => {
    const rules: BankRuleForMatch[] = [
      {
        id: 'rule-1',
        priority: 200,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
      {
        id: 'rule-2',
        priority: 100,
        createdAt: '2026-01-01T00:00:00Z',
        direction: 'ANY',
        memoContains: 'test',
        amountMinCents: null,
        amountMaxCents: null,
        bankAccountId: null,
      },
    ];

    const frozenRules = Object.freeze([...rules]);

    const line: BankLineForMatch = {
      description: 'test transaction',
      amountCents: 500,
      accountId: 'acc-1',
    };

    // Should not throw when accessing frozen array
    const match = findMatchingRule(line, frozenRules);
    expect(match?.id).toBe('rule-2');
  });
});
