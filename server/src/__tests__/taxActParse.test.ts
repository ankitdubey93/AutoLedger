import { describe, expect, it } from 'vitest';
import { estimateTokens, parseTaxAct } from '../utils/taxActParse.js';

/**
 * Unit tier — no database. parseTaxAct and estimateTokens are pure
 * functions; every expected value below is hand-computed.
 */

describe('parseTaxAct', () => {
  it('splits a two-section act into two chunks', () => {
    const chunks = parseTaxAct('Section 1. Short title\nfoo\n\nSection 2. Definitions\nbar', {
      actLabel: 'Test Act',
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.citation).toBe('Test Act, Section 1');
    expect(chunks[0]?.heading).toBe('Short title');
    expect(chunks[0]?.content).toContain('foo');
    expect(chunks[0]?.content).not.toContain('bar');
  });

  it('discards preamble before the first heading', () => {
    const chunks = parseTaxAct('PREAMBLE TEXT\n\nSection 1. A\nbody', { actLabel: 'Test Act' });
    expect(chunks).toHaveLength(1);
    for (const chunk of chunks) {
      expect(chunk.content).not.toContain('PREAMBLE');
    }
  });

  it('emits one chunk when no heading matches', () => {
    const chunks = parseTaxAct('just prose', { actLabel: 'Test Act' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.citation).toBe('Test Act');
    expect(chunks[0]?.heading).toBeNull();
  });

  it('parses a subsection number into the citation', () => {
    const chunks = parseTaxAct('Section 80C(2)(a) Deductions\nbody text', { actLabel: 'Test Act' });
    expect(chunks[0]?.citation).toBe('Test Act, Section 80C(2)(a)');
  });

  it('accepts the Sec. and S. abbreviations', () => {
    const chunks = parseTaxAct('Sec. 4 Charge\nx\n\nS. 5 Scope\ny', { actLabel: 'Test Act' });
    expect(chunks).toHaveLength(2);
  });

  it('splits an oversized section on paragraph boundaries', () => {
    const paragraph = (label: string): string => `${label} ${'word '.repeat(300)}`.trim();
    const body = [paragraph('one'), paragraph('two'), paragraph('three')].join('\n\n');
    const chunks = parseTaxAct(`Section 1. Big\n${body}`, { actLabel: 'Test Act', maxTokens: 400 });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.citation).toBe('Test Act, Section 1 (part 1)');
    expect(chunks[1]?.citation).toBe('Test Act, Section 1 (part 2)');
    expect(chunks[2]?.citation).toBe('Test Act, Section 1 (part 3)');
  });

  it('does not split a single oversized paragraph', () => {
    const hugeParagraph = 'word '.repeat(900).trim();
    const chunks = parseTaxAct(`Section 1. Big\n${hugeParagraph}`, { actLabel: 'Test Act', maxTokens: 400 });
    expect(chunks).toHaveLength(1);
  });

  it('numbers ordinals 0-based and continuously across sections', () => {
    const paragraph = (label: string): string => `${label} ${'word '.repeat(300)}`.trim();
    const body = [paragraph('one'), paragraph('two'), paragraph('three')].join('\n\n');
    const chunks = parseTaxAct(`Section 1. Big\n${body}`, { actLabel: 'Test Act', maxTokens: 400 });
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it('drops an empty section body without consuming an ordinal', () => {
    const chunks = parseTaxAct('Section 1. A\n\n\nSection 2. B\nbody', { actLabel: 'Test Act' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.ordinal).toBe(0);
  });

  it('estimateTokens returns at least 1 for a single character', () => {
    expect(estimateTokens('a')).toBe(1);
  });
});
