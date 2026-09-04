import { describe, expect, it } from 'vitest';
import { levenshtein, similarity } from '../utils/levenshtein.js';

/** Unit tier — no database. Known distances, symmetry, and bounded similarity. */

const PAIRS: Array<[string, string, number]> = [
  ['kitten', 'sitting', 3],
  ['saturday', 'sunday', 3],
  ['flaw', 'lawn', 2],
  ['abc', 'abc', 0],
  ['', 'abc', 3],
  ['abc', '', 3],
  ['', '', 0],
  ['acme ltd', 'acme limited', 4],
];

describe('levenshtein', () => {
  for (const [a, b, expected] of PAIRS) {
    it(`distance("${a}", "${b}") is ${String(expected)}`, () => {
      expect(levenshtein(a, b)).toBe(expected);
    });
  }

  it('is symmetric', () => {
    for (const [a, b] of PAIRS) {
      expect(levenshtein(a, b)).toBe(levenshtein(b, a));
    }
  });
});

describe('similarity', () => {
  it('is 1 for identical strings', () => {
    expect(similarity('abc', 'abc')).toBe(1);
  });

  it('is 1 for two empty strings', () => {
    expect(similarity('', '')).toBe(1);
  });

  it('is 0 for completely different equal-length strings', () => {
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('stays within [0, 1] for every known pair', () => {
    for (const [a, b] of PAIRS) {
      const sim = similarity(a, b);
      expect(sim).toBeGreaterThanOrEqual(0);
      expect(sim).toBeLessThanOrEqual(1);
    }
  });
});
