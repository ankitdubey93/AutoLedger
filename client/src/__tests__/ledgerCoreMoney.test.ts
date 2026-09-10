import { describe, expect, it } from 'vitest';
import { formatCents, parseCentsInput } from '../utils/money';

/**
 * The client's half of guardrails rule 3.
 *
 * The journal entry form disables its submit button on an integer-cent
 * comparison, so these helpers decide whether an entry looks balanced before it
 * is ever sent. The server and the database both re-check — but a UI that
 * disagrees with them would be its own bug.
 */

describe('parseCentsInput', () => {
  it('parses whole and decimal amounts', () => {
    expect(parseCentsInput('450')).toBe(45000);
    expect(parseCentsInput('450.50')).toBe(45050);
    expect(parseCentsInput('0.05')).toBe(5);
    expect(parseCentsInput('  12.34  ')).toBe(1234);
  });

  it('treats an empty field as zero, not as an error', () => {
    // Every line has both a debit and a credit input, and one of them is always
    // blank — blank has to mean zero or no line would ever validate.
    expect(parseCentsInput('')).toBe(0);
    expect(parseCentsInput('   ')).toBe(0);
  });

  it('rejects more than two decimal places rather than rounding silently', () => {
    // Quietly turning someone's 1.005 into 1.00 is worse than refusing it.
    expect(parseCentsInput('1.005')).toBeNull();
    expect(parseCentsInput('450.5555')).toBeNull();
  });

  it('rejects negatives, letters and stray symbols', () => {
    // A negative amount is expressed by using the other column, never a minus.
    expect(parseCentsInput('-450')).toBeNull();
    expect(parseCentsInput('45o')).toBeNull();
    expect(parseCentsInput('$450')).toBeNull();
    expect(parseCentsInput('1,000')).toBeNull();
    expect(parseCentsInput('1e5')).toBeNull();
  });

  it('absorbs float representation error', () => {
    expect(parseCentsInput('0.07')).toBe(7);
    expect(parseCentsInput('8.20')).toBe(820);
  });
});

describe('formatCents', () => {
  it('always shows two minor digits', () => {
    expect(formatCents(45000)).toBe('450.00');
    expect(formatCents(45050)).toBe('450.50');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(0)).toBe('0.00');
  });

  it('formats a negative balance with one leading minus', () => {
    // A type-aware net balance can legitimately be negative — a contra account,
    // or an expense account carrying a credit.
    expect(formatCents(-45000)).toBe('-450.00');
    expect(formatCents(-5)).toBe('-0.05');
  });

  it('round-trips against parseCentsInput', () => {
    for (const raw of ['0.00', '0.01', '9.99', '1234.56']) {
      const parsed = parseCentsInput(raw);
      expect(parsed).not.toBeNull();
      expect(formatCents(parsed as number)).toBe(raw);
    }
  });
});

describe('the balance check the form performs', () => {
  /** Mirrors JournalEntryPage's totals calculation. */
  function balanced(lines: { debit: string; credit: string }[]): boolean {
    let debits = 0;
    let credits = 0;
    for (const line of lines) {
      const d = parseCentsInput(line.debit);
      const c = parseCentsInput(line.credit);
      if (d === null || c === null) return false;
      debits += d;
      credits += c;
    }
    return debits === credits;
  }

  it('accepts a balanced two-line entry', () => {
    expect(balanced([{ debit: '450.00', credit: '' }, { debit: '', credit: '450.00' }])).toBe(true);
  });

  it('rejects an entry that is out by a cent', () => {
    // Integer equality, never a tolerance — a one-cent discrepancy is the
    // difference between a clean audit and a hunt through ten thousand entries.
    expect(balanced([{ debit: '450.00', credit: '' }, { debit: '', credit: '449.99' }])).toBe(false);
  });

  it('accepts a split entry across three lines', () => {
    expect(
      balanced([
        { debit: '300.00', credit: '' },
        { debit: '150.00', credit: '' },
        { debit: '', credit: '450.00' },
      ]),
    ).toBe(true);
  });

  it('sums many small amounts without drift', () => {
    // Ten lines of 0.10 against one of 1.00. As floats the left side is
    // 0.9999999999999999 and this would be false.
    const lines = Array.from({ length: 10 }, () => ({ debit: '0.10', credit: '' }));
    expect(balanced([...lines, { debit: '', credit: '1.00' }])).toBe(true);
  });
});
