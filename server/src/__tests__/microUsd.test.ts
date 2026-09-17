import { describe, expect, it } from 'vitest';
import { costMicroUsd, formatMicroUsd, microUsd, parseMicroUsd } from '../utils/microUsd.js';
import { ApiError } from '../utils/apiError.js';

/**
 * Unit tier — no database. Mirrors money.test.ts's discipline: these are
 * the tests guardrails rule 3 (extended to operational AI spend) rests on.
 */

describe('microUsd', () => {
  it('accepts an integer', () => {
    expect(microUsd(23_400)).toBe(23_400);
    expect(microUsd(0)).toBe(0);
  });

  it('rejects a non-integer', () => {
    expect(() => microUsd(1.5)).toThrow(ApiError);
    expect(() => microUsd(1.5)).toThrow('Cost must be a whole number of micro-USD');
  });
});

describe('costMicroUsd', () => {
  it('prices 1,000,000 tokens at $2.00/MTok as $2.00', () => {
    expect(costMicroUsd(1_000_000, 2_000_000)).toBe(2_000_000);
  });

  it('prices 1,500 tokens at $2.00/MTok as $0.003', () => {
    expect(costMicroUsd(1_500, 2_000_000)).toBe(3_000);
  });

  it('prices zero tokens as zero regardless of the rate', () => {
    expect(costMicroUsd(0, 10_000_000)).toBe(0);
  });

  it('prices one token', () => {
    expect(costMicroUsd(1, 2_000_000)).toBe(2);
  });

  it('rounds down below the half', () => {
    expect(costMicroUsd(1, 1)).toBe(0);
  });

  it('rounds up on exactly half', () => {
    expect(costMicroUsd(500_000, 1)).toBe(1);
  });

  it('rejects a negative token count', () => {
    expect(() => costMicroUsd(-1, 2_000_000)).toThrow(ApiError);
    expect(() => costMicroUsd(-1, 2_000_000)).toThrow('Token count must be a non-negative whole number');
  });

  it('rejects a negative price', () => {
    expect(() => costMicroUsd(100, -1)).toThrow(ApiError);
    expect(() => costMicroUsd(100, -1)).toThrow('Invalid token price');
  });

  it('does not overflow on a large input', () => {
    expect(costMicroUsd(50_000_000, 10_000_000)).toBe(500_000_000);
  });
});

describe('formatMicroUsd', () => {
  it('formats with six decimal places', () => {
    expect(formatMicroUsd(microUsd(23_400))).toBe('0.023400');
  });

  it('formats a whole dollar amount', () => {
    expect(formatMicroUsd(microUsd(2_000_000))).toBe('2.000000');
  });

  it('formats zero', () => {
    expect(formatMicroUsd(microUsd(0))).toBe('0.000000');
  });
});

describe('parseMicroUsd', () => {
  it('rejects a value past the safe integer range (the precision cliff)', () => {
    expect(() => parseMicroUsd('9007199254740993')).toThrow(ApiError);
    expect(() => parseMicroUsd('9007199254740993')).toThrow(
      'Cost value from database exceeds the safe integer range',
    );
  });

  it('rejects an unparseable value', () => {
    expect(() => parseMicroUsd('not-a-number')).toThrow(ApiError);
    expect(() => parseMicroUsd('not-a-number')).toThrow('Unparseable cost value from database');
  });
});
