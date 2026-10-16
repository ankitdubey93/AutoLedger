import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { optionalCsvList, optionalIsoDate, optionalText, optionalUuid, readPagination } from '../utils/queryParam.js';
import { ApiError } from '../utils/apiError.js';

/**
 * Unit tier — no database, no HTTP.
 *
 * `readPagination` never throws; the `optional*` readers throw a 400 with a
 * specific message on anything malformed. The fake request cast below is the
 * one sanctioned `as unknown as Request` in this codebase, confined here.
 */

function fakeRequest(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe('readPagination', () => {
  it('defaults to page 1, limit 20', () => {
    expect(readPagination({})).toEqual({ page: 1, limit: 20 });
  });

  it('reads valid page and limit', () => {
    expect(readPagination({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 });
  });

  it('caps limit at 100', () => {
    expect(readPagination({ limit: '10000' }).limit).toBe(100);
  });

  it('falls back to page 1 for a non-positive page', () => {
    expect(readPagination({ page: '0' }).page).toBe(1);
  });

  it('falls back to page 1 for a non-numeric page', () => {
    expect(readPagination({ page: 'abc' }).page).toBe(1);
  });
});

describe('optionalIsoDate', () => {
  it('returns null when the param is absent', () => {
    expect(optionalIsoDate(fakeRequest({}), 'from')).toBeNull();
  });

  it('returns a valid date string unchanged', () => {
    expect(optionalIsoDate(fakeRequest({ from: '2026-08-15' }), 'from')).toBe('2026-08-15');
  });

  it('rejects a malformed date with a 400 naming the field', () => {
    const req = fakeRequest({ from: '15/08/2026' });
    try {
      optionalIsoDate(req, 'from');
      throw new Error('expected optionalIsoDate to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe('from must be a date in YYYY-MM-DD format');
    }
  });
});

describe('optionalUuid', () => {
  it('accepts a valid uuid', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(optionalUuid(fakeRequest({ accountId: id }), 'accountId')).toBe(id);
  });

  it('rejects a non-uuid with a 400 naming the field', () => {
    const req = fakeRequest({ accountId: 'not-a-uuid' });
    try {
      optionalUuid(req, 'accountId');
      throw new Error('expected optionalUuid to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe('accountId must be a UUID');
    }
  });
});

describe('optionalText', () => {
  it('maps a blank value to null', () => {
    expect(optionalText(fakeRequest({ q: '   ' }), 'q', 200)).toBeNull();
  });

  it('maps an absent value to null', () => {
    expect(optionalText(fakeRequest({}), 'q', 200)).toBeNull();
  });

  it('trims and returns a present value', () => {
    expect(optionalText(fakeRequest({ q: '  aws  ' }), 'q', 200)).toBe('aws');
  });

  it('rejects a value over the max length', () => {
    const req = fakeRequest({ q: 'a'.repeat(201) });
    try {
      optionalText(req, 'q', 200);
      throw new Error('expected optionalText to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe('q must be at most 200 characters');
    }
  });
});

describe('optionalCsvList', () => {
  const LOWER = /^[a-z]+$/;

  it('splits, trims, drops empty items and de-duplicates, keeping order', () => {
    expect(optionalCsvList(fakeRequest({ names: 'a, b,,a' }), 'names', LOWER, 10, 'names is invalid')).toEqual([
      'a',
      'b',
    ]);
  });

  it('returns null when the param is absent', () => {
    expect(optionalCsvList(fakeRequest({}), 'names', LOWER, 10, 'names is invalid')).toBeNull();
  });

  it('rejects an item that fails the pattern with a 400 carrying the given message', () => {
    const req = fakeRequest({ names: 'ok,x!' });
    try {
      optionalCsvList(req, 'names', LOWER, 10, 'names is invalid');
      throw new Error('expected optionalCsvList to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe('names is invalid');
    }
  });

  it('rejects more than maxItems items', () => {
    const req = fakeRequest({ names: 'a,b,c' });
    try {
      optionalCsvList(req, 'names', LOWER, 2, 'names is invalid');
      throw new Error('expected optionalCsvList to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe('names is invalid');
    }
  });
});
