import { describe, expect, it } from 'vitest';
import { parseCsv } from '../utils/csv.js';
import { ApiError } from '../utils/apiError.js';

/**
 * Unit tier — no database. Pure state-machine parsing, tested against the
 * messy real-world CSV shapes bank exports actually produce.
 */

describe('parseCsv', () => {
  it('strips a UTF-8 BOM from the first header', () => {
    const table = parseCsv('﻿Date,Amount\n2026-01-02,10.00');
    expect(table.headers).toEqual(['Date', 'Amount']);
  });

  it('keeps a comma inside a quoted field', () => {
    const table = parseCsv('a,b\n"Smith, John",5');
    expect(table.rows[0]).toEqual(['Smith, John', '5']);
  });

  it('keeps a newline inside a quoted field', () => {
    const table = parseCsv('a,b\n"line1\nline2",5');
    expect(table.rows[0]?.[0]).toBe('line1\nline2');
    expect(table.rows.length).toBe(1);
  });

  it('unescapes a doubled quote', () => {
    const table = parseCsv('a\n"He said ""hi"""');
    expect(table.rows[0]?.[0]).toBe('He said "hi"');
  });

  it('handles CRLF line endings', () => {
    const table = parseCsv('a,b\r\n1,2\r\n');
    expect(table.rows).toEqual([['1', '2']]);
  });

  it('handles a bare CR line ending', () => {
    const table = parseCsv('a,b\r1,2');
    expect(table.rows).toEqual([['1', '2']]);
  });

  it('detects a semicolon delimiter', () => {
    const table = parseCsv('Date;Amount\n2026-01-02;10,00');
    expect(table.delimiter).toBe(';');
    expect(table.headers.length).toBe(2);
  });

  it('detects a tab delimiter', () => {
    const table = parseCsv('Date\tAmount\n2026-01-02\t10.00');
    expect(table.delimiter).toBe('\t');
  });

  it('does not detect a delimiter that only appears inside quotes', () => {
    const table = parseCsv('"a;b",c\n1,2');
    expect(table.delimiter).toBe(',');
    expect(table.headers).toEqual(['a;b', 'c']);
  });

  it('pads a short row', () => {
    const table = parseCsv('a,b,c\n1,2');
    expect(table.rows[0]).toEqual(['1', '2', '']);
  });

  it('rejects a row longer than the header', () => {
    expect(() => parseCsv('a,b\n1,2,3')).toThrow(ApiError);
    try {
      parseCsv('a,b\n1,2,3');
      throw new Error('expected parseCsv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toContain('row 2');
    }
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a\n"oops')).toThrow(ApiError);
  });

  it('rejects an empty file', () => {
    expect(() => parseCsv('')).toThrow(ApiError);
  });

  it('skips a blank trailing row', () => {
    const table = parseCsv('a,b\n1,2\n\n');
    expect(table.rows.length).toBe(1);
  });
});
