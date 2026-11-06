import { describe, expect, it } from 'vitest';
import { buildAbaFile, normalizeAccountNumber, normalizeBsb, type AbaCredit, type AbaHeader } from '../utils/abaFile.js';

const header: AbaHeader = {
  financialInstitution: 'CBA',
  userName: 'Harbour Bakery Pty Ltd',
  apcaUserId: '123456',
  description: 'Payments',
  processingDate: '2026-08-03',
  traceBsb: '062-000',
  traceAccountNumber: '12345678',
  remitterName: 'Harbour Bakery',
  selfBalancing: false,
};

const credit: AbaCredit = {
  bsb: '083-004',
  accountNumber: '987654321',
  accountName: 'Coastal Supplies',
  amountCents: 123_456,
  lodgementReference: 'INV 42',
};

describe('the ABA file', () => {
  it('matches the expected bytes exactly', () => {
    const expected =
      '0                 01CBA       HARBOUR BAKERY PTY LTD    123456PAYMENTS    030826                                        \r\n' +
      '1083-004987654321 500000123456COASTAL SUPPLIES                INV 42            062-000 12345678HARBOUR BAKERY  00000000\r\n' +
      '7999-999            000012345600001234560000000000                        000001                                        \r\n';
    expect(buildAbaFile(header, [credit])).toBe(expected);
  });

  it('makes every record exactly 120 characters, CRLF-ended', () => {
    const file = buildAbaFile({ ...header, selfBalancing: true }, [credit, { ...credit, accountName: 'x'.repeat(80), lodgementReference: 'y'.repeat(80) }]);
    const lines = file.split('\r\n');
    expect(lines.at(-1)).toBe('');
    for (const line of lines.slice(0, -1)) expect(line).toHaveLength(120);
  });

  it('totals credits, and counts only detail records', () => {
    const file = buildAbaFile(header, [credit, { ...credit, amountCents: 1_000 }]);
    const total = file.split('\r\n')[3] ?? '';
    expect(total.slice(20, 30)).toBe('0000124456');
    expect(total.slice(30, 40)).toBe('0000124456');
    expect(total.slice(40, 50)).toBe('0000000000');
    expect(total.slice(74, 80)).toBe('000002');
  });

  it('adds a balancing debit when the bank wants one, netting to zero', () => {
    const file = buildAbaFile({ ...header, selfBalancing: true }, [credit]);
    const lines = file.split('\r\n');
    const balancing = lines[2] ?? '';
    expect(balancing.slice(18, 20)).toBe('13');
    expect(balancing.slice(20, 30)).toBe('0000123456');
    expect(balancing.slice(1, 8)).toBe('062-000');
    const total = lines[3] ?? '';
    expect(total.slice(20, 30)).toBe('0000000000');
    expect(total.slice(30, 40)).toBe('0000123456');
    expect(total.slice(40, 50)).toBe('0000123456');
    expect(total.slice(74, 80)).toBe('000002');
  });

  it('strips what the format cannot carry, rather than corrupting the fixed width', () => {
    const file = buildAbaFile(header, [{ ...credit, accountName: 'Café Ñandú "Best" #1' }]);
    const line = file.split('\r\n')[1] ?? '';
    expect(line).toHaveLength(120);
    expect(line.slice(30, 62).trim()).toBe('CAF  AND BEST 1'.replace(/\s+/g, ' '));
  });

  it('refuses an impossible amount and an empty file', () => {
    expect(() => buildAbaFile(header, [])).toThrow(/at least one/);
    expect(() => buildAbaFile(header, [{ ...credit, amountCents: 0 }])).toThrow(/between/);
    expect(() => buildAbaFile(header, [{ ...credit, amountCents: 10_000_000_000 }])).toThrow(/between/);
  });
});

describe('bank number formats', () => {
  it.each([
    ['062000', '062-000'],
    ['062-000', '062-000'],
    ['062 000', '062-000'],
  ])('BSB %s', (input, expected) => {
    expect(normalizeBsb(input)).toBe(expected);
  });

  it.each(['06200', '0620000', 'abc-def', ''])('refuses BSB %s', (input) => {
    expect(normalizeBsb(input)).toBeNull();
  });

  it('allows up to nine characters for an account', () => {
    expect(normalizeAccountNumber('12 345 678')).toBe('12345678');
    expect(normalizeAccountNumber('1234-5678')).toBe('1234-5678');
    expect(normalizeAccountNumber('1234567890')).toBeNull();
    expect(normalizeAccountNumber('---')).toBeNull();
    expect(normalizeAccountNumber('ABC')).toBeNull();
  });
});
