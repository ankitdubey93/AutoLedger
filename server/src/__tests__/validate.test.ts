import { describe, expect, it } from 'vitest';
import {
  optionalString,
  requireBodyObject,
  requireEmail,
  requirePassword,
  requireString,
  requireUuid,
  slugify,
} from '../utils/validate.js';
import { ApiError } from '../utils/apiError.js';

/**
 * Unit tier — no database, no HTTP.
 *
 * These functions are the only thing standing between a request body and the
 * service layer, which makes them security-relevant. Hand-rolling them instead
 * of adding zod is only defensible if they are actually tested.
 */

describe('requireBodyObject', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'nope'],
    ['undefined', undefined],
  ])('rejects %s', (_label, input) => {
    // typeof null === 'object' and arrays are objects, so both slip past a
    // naive check and then read as undefined fields.
    expect(() => requireBodyObject(input)).toThrow(ApiError);
  });

  it('accepts a plain object', () => {
    expect(requireBodyObject({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('requireString', () => {
  it('trims surrounding whitespace', () => {
    expect(requireString({ name: '  Ada  ' }, 'name')).toBe('Ada');
  });

  it.each([
    ['a missing field', {}],
    ['a non-string', { name: 42 }],
    ['whitespace only', { name: '   ' }],
  ])('rejects %s', (_label, body) => {
    expect(() => requireString(body, 'name')).toThrow(ApiError);
  });

  it('enforces min and max length', () => {
    expect(() => requireString({ n: 'ab' }, 'n', { min: 3 })).toThrow(/at least 3/);
    expect(() => requireString({ n: 'abcd' }, 'n', { max: 3 })).toThrow(/at most 3/);
  });
});

describe('optionalString', () => {
  it.each([
    ['absent', {}],
    ['null', { name: null }],
    ['empty', { name: '' }],
  ])('maps %s to null', (_label, body) => {
    // Must be null, never the string "undefined" reaching a NOT NULL column.
    expect(optionalString(body, 'name')).toBeNull();
  });

  it('returns a present value', () => {
    expect(optionalString({ name: 'Ada' }, 'name')).toBe('Ada');
  });
});

describe('requireEmail', () => {
  it('lowercases on the way in', () => {
    // guardrails rule 9 — normalised at the boundary so the functional unique
    // index and every later comparison agree.
    expect(requireEmail({ email: 'Ada@Example.COM' })).toBe('ada@example.com');
  });

  it.each(['no-at-sign', 'no@domain', 'spaces in@example.com', '@example.com'])(
    'rejects %s',
    (email) => {
      expect(() => requireEmail({ email })).toThrow(ApiError);
    },
  );
});

describe('requirePassword', () => {
  it('does not trim — spaces are legitimate password characters', () => {
    // Silently stripping them would lock a user out of the password they set.
    expect(requirePassword({ password: '  spaced out  ' })).toBe('  spaced out  ');
  });

  it('rejects anything under 8 characters', () => {
    expect(() => requirePassword({ password: 'short12' })).toThrow(/at least 8/);
  });

  it('measures the maximum in bytes, not characters', () => {
    // 72 ASCII characters fit exactly; 72 emoji are 288 bytes and would be
    // truncated by bcrypt to something that collides with other passwords.
    expect(requirePassword({ password: 'x'.repeat(72) })).toHaveLength(72);
    expect(() => requirePassword({ password: 'x'.repeat(73) })).toThrow(/72 bytes/);
    expect(() => requirePassword({ password: '😀'.repeat(19) })).toThrow(/72 bytes/);
  });
});

describe('requireUuid', () => {
  it('accepts a v4 uuid', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(requireUuid({ orgId: id }, 'orgId')).toBe(id);
  });

  it.each(['', 'not-a-uuid', '3f2504e0-4f89-41d3-9a0c'])('rejects %s', (value) => {
    // Caught here as a clean 400 rather than reaching Postgres as a 500-shaped
    // driver error.
    expect(() => requireUuid({ orgId: value }, 'orgId')).toThrow(ApiError);
  });
});

describe('slugify', () => {
  it.each([
    ['Acme Traders', 'acme-traders'],
    ['  Spaced   Out  ', 'spaced-out'],
    ['Ünïcodé Cafè', 'unicode-cafe'],
    ['Punctuation!!! & Symbols***', 'punctuation-symbols'],
  ])('%s -> %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('falls back rather than returning an empty slug', () => {
    // A name of only punctuation or non-Latin script would otherwise produce
    // '', which collides with every other such name.
    expect(slugify('!!!')).toBe('org');
    expect(slugify('日本語')).toBe('org');
  });

  it('caps length', () => {
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
});
