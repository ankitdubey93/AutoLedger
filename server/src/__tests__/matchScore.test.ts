import { describe, expect, it } from 'vitest';
import {
  AUTO_MATCH_THRESHOLD,
  DATE_POINTS,
  normalizeForMatching,
  scoreMatch,
  type BankLineForScoring,
  type CandidateForScoring,
} from '../utils/matchScore.js';

/** Unit tier — no database. Pure scoring logic. */

function line(overrides: Partial<BankLineForScoring> = {}): BankLineForScoring {
  return {
    amountCents: 50000,
    txnDate: '2026-03-09',
    description: 'FASTER PAYMENT',
    externalReference: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateForScoring> = {}): CandidateForScoring {
  return {
    documentAmountDueCents: 50000,
    documentDate: '2026-03-09',
    counterpartyName: 'Acme Ltd',
    documentReference: 'INV-1042',
    ...overrides,
  };
}

describe('scoreMatch', () => {
  it('a perfect match scores 100', () => {
    const result = scoreMatch(
      line({ description: 'FASTER PAYMENT INV 1042' }),
      candidate(),
    );
    expect(result.total).toBe(100);
  });

  it('a sign-flipped amount still matches on absolute value', () => {
    const result = scoreMatch(line({ amountCents: -50000 }), candidate({ documentAmountDueCents: 50000 }));
    expect(result.amount.points).toBe(40);
  });

  it('a different amount scores zero on amount', () => {
    const result = scoreMatch(line({ amountCents: 50001 }), candidate({ documentAmountDueCents: 50000 }));
    expect(result.amount.points).toBe(0);
  });

  it('date points step down with distance', () => {
    const expectedByDays = [DATE_POINTS[0], DATE_POINTS[1], DATE_POINTS[2], DATE_POINTS[3], 0];
    for (const [days, expected] of expectedByDays.entries()) {
      const result = scoreMatch(
        line({ txnDate: `2026-03-${String(9 + days).padStart(2, '0')}` }),
        candidate({ documentDate: '2026-03-09' }),
      );
      expect(result.date.points).toBe(expected);
    }
  });

  it('the reference beats the name when only the reference is in the memo', () => {
    const result = scoreMatch(
      line({ description: 'FASTER PAYMENT INV 1042', externalReference: null }),
      candidate({ counterpartyName: 'Wholly Unrelated Co', documentReference: 'INV-1042' }),
    );
    expect(result.counterparty.points).toBe(30);
  });

  it('a partial name match scores partially', () => {
    const result = scoreMatch(
      line({ description: 'ACME LIMITED', externalReference: null }),
      candidate({ counterpartyName: 'Acme Ltd', documentReference: '' }),
    );
    expect(result.counterparty.points).toBeGreaterThan(0);
    expect(result.counterparty.points).toBeLessThan(30);
  });

  it('no overlap scores zero on counterparty', () => {
    const result = scoreMatch(
      line({ description: 'ATM WITHDRAWAL', externalReference: null }),
      candidate({ counterpartyName: 'Acme Ltd', documentReference: 'INV-1' }),
    );
    expect(result.counterparty.points).toBe(0);
  });

  it('total never exceeds 100', () => {
    const perfect = scoreMatch(line({ description: 'FASTER PAYMENT INV 1042' }), candidate());
    expect(perfect.total).toBeLessThanOrEqual(100);
    const zero = scoreMatch(
      line({ amountCents: 1, description: 'ATM WITHDRAWAL', txnDate: '2020-01-01' }),
      candidate(),
    );
    expect(zero.total).toBeGreaterThanOrEqual(0);
    expect(zero.total).toBeLessThanOrEqual(100);
  });

  it('normalizeForMatching collapses punctuation', () => {
    expect(normalizeForMatching('ACME  Ltd. — #1042')).toBe('acme ltd 1042');
  });

  it('AUTO_MATCH_THRESHOLD is 85', () => {
    expect(AUTO_MATCH_THRESHOLD).toBe(85);
  });
});
