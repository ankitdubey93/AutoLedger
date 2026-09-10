import { describe, expect, it } from 'vitest';
import { sniffMimeType } from '../utils/mimeSniff.js';

/** Unit tier — no database. Magic-byte detection and the CSV text carve-out. */

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('sniffMimeType', () => {
  it('detects a PDF by its %PDF- signature', () => {
    expect(sniffMimeType(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'), 'x.pdf')).toBe(
      'application/pdf',
    );
  });

  it('detects a PNG by its 8-byte signature', () => {
    expect(sniffMimeType(Buffer.from([...PNG_SIGNATURE, 0, 0]), 'x.png')).toBe('image/png');
  });

  it('detects a JPEG by FF D8 FF', () => {
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'x.jpg')).toBe('image/jpeg');
  });

  it('accepts UTF-8 text named .csv', () => {
    expect(sniffMimeType(Buffer.from('date,amount\n2026-01-01,10.00\n'), 's.csv')).toBe(
      'text/csv',
    );
  });

  it('strips a BOM before the CSV check', () => {
    const buf = Buffer.concat([UTF8_BOM, Buffer.from('a,b\n1,2\n')]);
    expect(sniffMimeType(buf, 's.csv')).toBe('text/csv');
  });

  it('refuses text not named .csv', () => {
    expect(sniffMimeType(Buffer.from('hello'), 'notes.txt')).toBeNull();
  });

  it('refuses a buffer containing a NUL byte', () => {
    expect(sniffMimeType(Buffer.from([0x68, 0x00, 0x69]), 's.csv')).toBeNull();
  });

  it('a PNG renamed .csv is still a PNG', () => {
    expect(sniffMimeType(Buffer.from([...PNG_SIGNATURE, 1, 2]), 'evil.csv')).toBe('image/png');
  });

  it('an executable claiming to be a PDF is refused', () => {
    expect(sniffMimeType(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'invoice.pdf')).toBeNull();
  });

  it('refuses an empty buffer', () => {
    expect(sniffMimeType(Buffer.alloc(0), 's.csv')).toBeNull();
  });
});
