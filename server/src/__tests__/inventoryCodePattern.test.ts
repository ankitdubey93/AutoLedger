import { describe, expect, it } from 'vitest';
import {
  exampleCode,
  parseCodePattern,
  renderCode,
  renderScopeKey,
  type CodeRenderContext,
} from '../utils/stockCodePattern.js';

/** Inventory (Phase 28) — the item-code pattern parser and renderer. Pure unit tier. */

function ctx(overrides: Partial<CodeRenderContext> = {}): CodeRenderContext {
  return { categoryCode: 'RM', attributes: {}, date: new Date('2026-06-15T00:00:00Z'), ...overrides };
}

describe('parseCodePattern', () => {
  it('parses category + sequence', () => {
    const result = parseCodePattern('{CAT}-{SEQ:5}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.segments).toHaveLength(3);
  });

  it('rejects zero or two SEQ tokens', () => {
    const zero = parseCodePattern('{CAT}');
    expect(zero).toEqual({ ok: false, error: 'Pattern needs exactly one {SEQ:n}' });

    const two = parseCodePattern('{SEQ:3}-{SEQ:4}');
    expect(two).toEqual({ ok: false, error: 'Pattern needs exactly one {SEQ:n}' });
  });

  it('rejects an unknown token', () => {
    expect(parseCodePattern('{FOO}-{SEQ:4}')).toEqual({ ok: false, error: 'Unknown token "{FOO}"' });
  });

  it('rejects lower-case literal', () => {
    expect(parseCodePattern('rm-{SEQ:4}')).toEqual({
      ok: false,
      error: 'Character "r" is not allowed; use A-Z, 0-9, - _ / .',
    });
  });

  it('rejects SEQ width 2 and 9', () => {
    expect(parseCodePattern('{SEQ:2}')).toEqual({ ok: false, error: '{SEQ:n} width must be 3 to 8' });
    expect(parseCodePattern('{SEQ:9}')).toEqual({ ok: false, error: '{SEQ:n} width must be 3 to 8' });
  });

  it('rejects an unclosed brace', () => {
    expect(parseCodePattern('{SEQ:4')).toEqual({ ok: false, error: 'Unclosed "{"' });
  });

  it('rejects an empty pattern', () => {
    expect(parseCodePattern('')).toEqual({ ok: false, error: 'Pattern is empty' });
  });

  it('rejects a pattern longer than 60 characters', () => {
    const pattern = `${'A'.repeat(55)}-{SEQ:3}`;
    expect(pattern.length).toBeGreaterThan(60);
    expect(parseCodePattern(pattern)).toEqual({ ok: false, error: 'Pattern is longer than 60 characters' });
  });

  it('rejects an ATTR length outside 1-10', () => {
    expect(parseCodePattern('{ATTR:color:0}-{SEQ:3}')).toEqual({
      ok: false,
      error: '{ATTR:key:n} length must be 1 to 10',
    });
    expect(parseCodePattern('{ATTR:color:11}-{SEQ:3}')).toEqual({
      ok: false,
      error: '{ATTR:key:n} length must be 1 to 10',
    });
  });
});

describe('renderCode', () => {
  it('renders RM-00042', () => {
    const parsed = parseCodePattern('{CAT}-{SEQ:5}');
    if (!parsed.ok) throw new Error('fixture pattern must parse');
    expect(renderCode(parsed.segments, ctx({ categoryCode: 'RM' }), 42)).toEqual({ ok: true, value: 'RM-00042' });
  });

  it('renders year tokens in UTC', () => {
    const parsed = parseCodePattern('{CAT}-{YY}-{SEQ:4}');
    if (!parsed.ok) throw new Error('fixture pattern must parse');
    const date = new Date('2026-12-31T23:30:00-05:00'); // 2027-01-01T04:30:00Z
    expect(renderCode(parsed.segments, ctx({ categoryCode: 'FG', date }), 1)).toEqual({
      ok: true,
      value: 'FG-27-0001',
    });
  });

  it('renders attribute segment sanitized and truncated', () => {
    const parsed = parseCodePattern('{CAT}-{ATTR:color:3}-{SEQ:4}');
    if (!parsed.ok) throw new Error('fixture pattern must parse');
    const result = renderCode(
      parsed.segments,
      ctx({ categoryCode: 'APP', attributes: { color: 'navy blue' } }),
      1,
    );
    expect(result).toEqual({ ok: true, value: 'APP-NAV-0001' });
  });

  it('renders boolean and date attributes', () => {
    const boolPattern = parseCodePattern('{ATTR:corner:1}-{SEQ:3}');
    if (!boolPattern.ok) throw new Error('fixture pattern must parse');
    expect(renderCode(boolPattern.segments, ctx({ attributes: { corner: true } }), 1)).toEqual({
      ok: true,
      value: 'Y-001',
    });

    const datePattern = parseCodePattern('{ATTR:made:8}-{SEQ:3}');
    if (!datePattern.ok) throw new Error('fixture pattern must parse');
    expect(renderCode(datePattern.segments, ctx({ attributes: { made: '2026-09-22' } }), 1)).toEqual({
      ok: true,
      value: '20260922-001',
    });
  });

  it('rejects a missing attribute', () => {
    const parsed = parseCodePattern('{CAT}-{ATTR:color:3}-{SEQ:4}');
    if (!parsed.ok) throw new Error('fixture pattern must parse');
    expect(renderCode(parsed.segments, ctx({ attributes: {} }), 1)).toEqual({
      ok: false,
      error: 'Code scheme needs attribute "color" to generate a code',
    });
  });

  it('exhausts at 10^width', () => {
    const parsed = parseCodePattern('{SEQ:3}');
    if (!parsed.ok) throw new Error('fixture pattern must parse');
    expect(renderCode(parsed.segments, ctx(), 1000)).toEqual({
      ok: false,
      error: 'Code sequence exhausted for this scheme',
    });
    expect(renderCode(parsed.segments, ctx(), 999)).toEqual({ ok: true, value: '999' });
  });

  it('rejects a code over 40 characters', () => {
    const pattern = `${'A'.repeat(33)}-{SEQ:8}`;
    expect(pattern.length).toBeLessThanOrEqual(60);
    const parsed = parseCodePattern(pattern);
    if (!parsed.ok) throw new Error('fixture pattern must parse');
    const result = renderCode(parsed.segments, ctx(), 1);
    expect(result).toEqual({ ok: false, error: 'Generated code is longer than 40 characters' });
  });
});

describe('renderScopeKey', () => {
  it('scope key replaces SEQ with #', () => {
    const parsed = parseCodePattern('{CAT}-{YY}-{SEQ:4}');
    if (!parsed.ok) throw new Error('fixture pattern must parse');
    const date = new Date('2026-06-15T00:00:00Z');
    expect(renderScopeKey(parsed.segments, ctx({ categoryCode: 'FG', date }))).toEqual({
      ok: true,
      value: 'FG-26-#',
    });
  });
});

describe('exampleCode', () => {
  it('exampleCode renders ATTR from the key', () => {
    expect(exampleCode('{ATTR:brand:3}-{SEQ:5}', 'CAT', new Date('2026-01-01T00:00:00Z'))).toEqual({
      ok: true,
      value: 'BRA-00001',
    });
  });

  it('propagates a parse error', () => {
    expect(exampleCode('{FOO}-{SEQ:4}', 'CAT', new Date('2026-01-01T00:00:00Z'))).toEqual({
      ok: false,
      error: 'Unknown token "{FOO}"',
    });
  });
});
