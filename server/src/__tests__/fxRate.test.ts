import { describe, expect, it } from 'vitest';
import { convertToBase, isCurrencyCode, ONE_RATE, rateNumerator } from '../utils/fxRate.js';
import { cents } from '../utils/money.js';
import { ApiError } from '../utils/apiError.js';

/**
 * Unit tier — no database. Pins the arithmetic realized/unrealized FX (and
 * every document rate) rests on.
 */

describe('rateNumerator', () => {
  it('parses a full 8-decimal rate', () => {
    expect(rateNumerator('83.50000000')).toBe(8350000000);
  });

  it('right-pads a short fraction', () => {
    expect(rateNumerator('83.5')).toBe(8350000000);
  });

  it('parses a whole number', () => {
    expect(rateNumerator('1')).toBe(100000000);
  });

  it('rejects zero', () => {
    expect(() => rateNumerator('0')).toThrow(ApiError);
    expect(() => rateNumerator('0')).toThrow('Unparseable exchange rate from database');
  });

  it('rejects non-numeric text', () => {
    expect(() => rateNumerator('abc')).toThrow(ApiError);
  });
});

describe('convertToBase', () => {
  it('converts the worked example day 1 ($1,000 at 83.00)', () => {
    expect(convertToBase(cents(100000), '83.00000000')).toBe(8300000);
  });

  it('converts the worked example day 10 ($1,000 at 83.50)', () => {
    expect(convertToBase(cents(100000), '83.50000000')).toBe(8350000);
  });

  it('rounds half up', () => {
    expect(convertToBase(cents(1), '0.00500000')).toBe(0);
    expect(convertToBase(cents(1), '0.50000000')).toBe(1);
  });

  it('is exact at identity', () => {
    expect(convertToBase(cents(12345), ONE_RATE)).toBe(12345);
  });
});

describe('isCurrencyCode', () => {
  it('accepts three uppercase letters', () => {
    expect(isCurrencyCode('USD')).toBe(true);
  });

  it('rejects lowercase and wrong length', () => {
    expect(isCurrencyCode('usd')).toBe(false);
    expect(isCurrencyCode('USDX')).toBe(false);
  });
});
