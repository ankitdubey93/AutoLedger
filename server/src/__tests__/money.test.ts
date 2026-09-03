import { describe, expect, it } from 'vitest';
import { addCents, cents, formatCents, parseCents, scaleCents, sumCents, toCents } from '../utils/money.js';
import { ApiError } from '../utils/apiError.js';

/**
 * Unit tier — no database.
 *
 * These are the tests guardrails rule 3 rests on. The prior build's central
 * invariant was checked with a `< 0.01` epsilon, so the arithmetic here is the
 * thing most worth pinning down.
 */

describe('cents', () => {
  it('accepts an integer', () => {
    expect(cents(45000)).toBe(45000);
    expect(cents(0)).toBe(0);
    expect(cents(-45000)).toBe(-45000);
  });

  it('rejects a non-integer', () => {
    expect(() => cents(1.5)).toThrow(ApiError);
    expect(() => cents(1.5)).toThrow('Amount must be a whole number of cents');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => cents(Number.NaN)).toThrow(ApiError);
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(ApiError);
  });

  it('rejects a value beyond the safe integer range', () => {
    expect(() => cents(2 ** 53)).toThrow('Amount is outside the safe integer range');
  });
});

describe('toCents', () => {
  it('converts major units', () => {
    expect(toCents(450.5)).toBe(45050);
    expect(toCents(450)).toBe(45000);
    expect(toCents(0)).toBe(0);
  });

  it('absorbs the classic float representation error', () => {
    // 0.1 + 0.2 is 0.30000000000000004, and 30.000000000000004 rounds to 30.
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it('rounds half away from zero, symmetrically for both signs', () => {
    expect(toCents(0.125)).toBe(13);
    expect(toCents(-0.125)).toBe(-13);
    // Math.round alone would give -12 here, rounding half toward +Infinity.
  });

  it('documents the 1.005 case rather than pretending it works', () => {
    // 1.005 * 100 is 100.49999999999999 in binary floating point, so this is
    // 100 and not 101. The loss happens in the caller's `number` literal, before
    // this function sees it — which is the argument for parsing money from
    // strings at any textual boundary. Asserted so the behaviour is a recorded
    // property rather than a surprise discovered in production.
    expect(toCents(1.005)).toBe(100);
  });

  it('rejects a non-finite input', () => {
    expect(() => toCents(Number.NaN)).toThrow('Amount must be a finite number');
  });
});

describe('parseCents', () => {
  it('parses what pg returns for a BIGINT column', () => {
    expect(parseCents('45000')).toBe(45000);
    expect(parseCents('-45000')).toBe(-45000);
    expect(parseCents('0')).toBe(0);
  });

  it('rejects a value that would silently lose precision', () => {
    // Number.parseInt('9007199254740993') returns 9007199254740992 without
    // complaint. Detecting that is the entire reason this goes via BigInt.
    expect(() => parseCents('9007199254740993')).toThrow(
      'Money value from database exceeds the safe integer range',
    );
  });

  it('rejects a non-numeric string', () => {
    expect(() => parseCents('450.00')).toThrow('Unparseable money value from database');
    expect(() => parseCents('')).toThrow('Unparseable money value from database');
    expect(() => parseCents('abc')).toThrow('Unparseable money value from database');
  });
});

describe('formatCents', () => {
  it('formats with exactly two minor digits', () => {
    expect(formatCents(cents(45000))).toBe('450.00');
    expect(formatCents(cents(45050))).toBe('450.50');
    expect(formatCents(cents(5))).toBe('0.05');
    expect(formatCents(cents(0))).toBe('0.00');
  });

  it('formats a negative amount with a single leading minus', () => {
    expect(formatCents(cents(-45000))).toBe('-450.00');
    expect(formatCents(cents(-5))).toBe('-0.05');
  });

  it('round-trips through toCents', () => {
    expect(formatCents(toCents(1234.56))).toBe('1234.56');
  });
});

describe('addCents and sumCents', () => {
  it('adds', () => {
    expect(addCents(cents(100), cents(250))).toBe(350);
  });

  it('sums an empty list to zero', () => {
    expect(sumCents([])).toBe(0);
  });

  it('sums a list exactly, with no accumulated drift', () => {
    // The same figures as floats: 0.1 added ten times is 0.9999999999999999.
    const tenth = toCents(0.1);
    expect(sumCents(Array.from({ length: 10 }, () => tenth))).toBe(100);
  });
});

describe('scaleCents', () => {
  it('applies a basis-point tax rate exactly', () => {
    expect(scaleCents(cents(10000), 1850, 10000)).toBe(1850);
  });

  it('rounds half up on a fractional result', () => {
    // 333 * 1850 / 10000 = 61.605 -> rounds up to 62.
    expect(scaleCents(cents(333), 1850, 10000)).toBe(62);
  });

  it('rounds an exact half up', () => {
    expect(scaleCents(cents(1), 1, 2)).toBe(1);
  });

  it('throws when the result leaves the safe integer range', () => {
    expect(() => scaleCents(cents(Number.MAX_SAFE_INTEGER), 2, 1)).toThrow(ApiError);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => scaleCents(cents(100), 1, 0)).toThrow(ApiError);
    expect(() => scaleCents(cents(100), 1, -5)).toThrow(ApiError);
  });

  it('rejects a negative numerator', () => {
    expect(() => scaleCents(cents(100), -1, 10)).toThrow(ApiError);
  });
});
