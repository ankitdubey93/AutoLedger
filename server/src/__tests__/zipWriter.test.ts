import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildZip } from '../utils/zipWriter.js';
import {
  bpToFraction,
  bpToPercentText,
  centsToDecimal,
  groupedCents,
  isoToExcelSerial,
  milliToDecimal,
} from '../utils/reportCellText.js';
import { readZip } from './helpers/zipReader.js';

/** Unit tier — no database. */

describe('buildZip', () => {
  it('round-trips two entries', () => {
    const entries = [
      { path: 'a.txt', data: Buffer.from('hello') },
      { path: 'dir/b.xml', data: Buffer.from('<x/>'.repeat(500)) },
    ];
    const read = readZip(buildZip(entries));
    expect(read.size).toBe(2);
    for (const e of entries) expect(read.get(e.path)?.equals(e.data)).toBe(true);
  });

  it('stores incompressible data uncompressed', () => {
    const zip = buildZip([{ path: 'r.bin', data: crypto.randomBytes(64) }]);
    expect(zip.readUInt16LE(8)).toBe(0);
  });

  it('is deterministic', () => {
    const entries = [{ path: 'a.txt', data: Buffer.from('same '.repeat(100)) }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
  });

  it('writes UTF-8 names', () => {
    const read = readZip(buildZip([{ path: 'é.txt', data: Buffer.from('x') }]));
    expect(read.has('é.txt')).toBe(true);
  });
});

describe('report cell text', () => {
  it('formats integers without floats', () => {
    expect(centsToDecimal(123456)).toBe('1234.56');
    expect(centsToDecimal(-5)).toBe('-0.05');
    expect(groupedCents(123456789)).toBe('1,234,567.89');
    expect(groupedCents(-100)).toBe('-1.00');
    expect(bpToFraction(1250)).toBe('0.1250');
    expect(bpToFraction(-50)).toBe('-0.0050');
    expect(bpToPercentText(1250)).toBe('12.50%');
    expect(bpToPercentText(null)).toBe('');
    expect(milliToDecimal(2500)).toBe('2.5');
    expect(milliToDecimal(1000)).toBe('1');
    expect(isoToExcelSerial('1970-01-01')).toBe(25569);
    expect(isoToExcelSerial('2026-10-16')).toBe(46311);
  });
});
