import { describe, expect, it } from 'vitest';
import { formatQuantityMilli, parseQuantityToMilli } from '../utils/quantity';

/** StockLedger (Phase 28) — the quantity formatter/parser. Pure unit tier. */

describe('formatQuantityMilli', () => {
  it('formats 2500 as 2.5', () => {
    expect(formatQuantityMilli(2500)).toBe('2.5');
  });

  it('formats 1000 as 1', () => {
    expect(formatQuantityMilli(1000)).toBe('1');
  });
});

describe('parseQuantityToMilli', () => {
  it('parses 2.5 with 3 dp', () => {
    expect(parseQuantityToMilli('2.5', 3)).toBe(2500);
  });

  it('rejects 2.5 with 0 dp', () => {
    expect(parseQuantityToMilli('2.5', 0)).toBeNull();
  });

  it('rejects -1', () => {
    expect(parseQuantityToMilli('-1', 3)).toBeNull();
  });

  it('parses 0.001 with 3 dp as 1', () => {
    expect(parseQuantityToMilli('0.001', 3)).toBe(1);
  });
});
