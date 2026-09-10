import { describe, expect, it } from 'vitest';
import { luhn, verhoeff } from '../utils/checksum.js';

describe('luhn', () => {
  it('validates known-good card numbers', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('5500005555555559')).toBe(true);
    expect(luhn('79927398713')).toBe(true);
  });

  it('rejects a single flipped digit', () => {
    expect(luhn('4111111111111112')).toBe(false);
    expect(luhn('79927398710')).toBe(false);
  });

  it('rejects empty and non-digit input', () => {
    expect(luhn('')).toBe(false);
    expect(luhn('abcd')).toBe(false);
  });
});

describe('verhoeff', () => {
  // '2363' is Wikipedia's own worked example for the Verhoeff algorithm:
  // the check digit computed for '236' is '3', making '2363' valid.
  it('validates the canonical Verhoeff vector', () => {
    expect(verhoeff('2363')).toBe(true);
  });

  it('rejects a single flipped digit', () => {
    expect(verhoeff('2364')).toBe(false);
  });

  it('rejects empty and non-digit input', () => {
    expect(verhoeff('')).toBe(false);
    expect(verhoeff('12x4')).toBe(false);
  });
});
