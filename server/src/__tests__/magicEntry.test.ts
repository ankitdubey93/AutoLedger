import { describe, it, expect } from 'vitest';
import { parseTransaction } from '../utils/ruleEngine';

/**
 * Mock chart of accounts containing exactly the accounts referenced
 * by the 5 CSV training rows used in these tests.
 */
const mockAccounts = [
  { id: 'a1', name: 'Rent Expense',        code: '6100', type: 'Expense'   },
  { id: 'a2', name: 'Bank',                code: '1001', type: 'Asset'     },
  { id: 'a3', name: 'Service Revenue',     code: '4001', type: 'Revenue'   },
  { id: 'a4', name: 'Insurance Expense',   code: '6200', type: 'Expense'   },
  { id: 'a5', name: 'Prepaid Insurance',   code: '1300', type: 'Asset'     },
  { id: 'a6', name: 'Professional Fees',   code: '6300', type: 'Expense'   },
  { id: 'a7', name: 'Accrued Liabilities', code: '2100', type: 'Liability' },
  { id: 'a8', name: 'Salaries Expense',    code: '6400', type: 'Expense'   },
];

/** Asserts debitSum === creditSum in integer cents and returns both sums. */
function assertBalance(lines: Array<{ debit: number; credit: number }>) {
  const toCents = (n: number) => Math.round(n * 100);
  const dr = lines.reduce((s, l) => s + toCents(l.debit), 0);
  const cr = lines.reduce((s, l) => s + toCents(l.credit), 0);
  expect(dr).toBe(cr);
  return { dr, cr };
}

describe('magicEntry — CSV rule engine integration', () => {

  it('1. routes "Paid office rent" → Rent Expense (Dr) / Bank (Cr)', () => {
    const result = parseTransaction(
      'Paid 1500 for monthly office rent via Bank',
      mockAccounts,
    );

    expect(result.lines).toHaveLength(2);
    const { dr } = assertBalance(result.lines);
    expect(dr).toBe(150000); // 1500.00 in cents

    expect(result.lines[0].accountName).toBe('Rent Expense');
    expect(result.lines[0].debit).toBe(1500);
    expect(result.lines[0].credit).toBe(0);

    expect(result.lines[1].accountName).toBe('Bank');
    expect(result.lines[1].debit).toBe(0);
    expect(result.lines[1].credit).toBe(1500);
  });

  it('2. routes "Received for web development" → Bank (Dr) / Service Revenue (Cr)', () => {
    const result = parseTransaction(
      'Received 5000 from client for web development services',
      mockAccounts,
    );

    expect(result.lines).toHaveLength(2);
    assertBalance(result.lines);

    expect(result.lines[0].accountName).toBe('Bank');
    expect(result.lines[0].debit).toBe(5000);
    expect(result.lines[0].credit).toBe(0);

    expect(result.lines[1].accountName).toBe('Service Revenue');
    expect(result.lines[1].debit).toBe(0);
    expect(result.lines[1].credit).toBe(5000);
  });

  it('3. routes "Amortized prepaid insurance" → Insurance Expense (Dr) / Prepaid Insurance (Cr)', () => {
    const result = parseTransaction(
      'Amortized 100 of prepaid insurance for the current month',
      mockAccounts,
    );

    expect(result.lines).toHaveLength(2);
    assertBalance(result.lines);

    expect(result.lines[0].accountName).toBe('Insurance Expense');
    expect(result.lines[0].debit).toBe(100);
    expect(result.lines[0].credit).toBe(0);

    expect(result.lines[1].accountName).toBe('Prepaid Insurance');
    expect(result.lines[1].debit).toBe(0);
    expect(result.lines[1].credit).toBe(100);
  });

  it('4. routes "Accrued accounting services" → Professional Fees (Dr) / Accrued Liabilities (Cr)', () => {
    const result = parseTransaction(
      'Accrued 400 for accounting services used but not yet billed',
      mockAccounts,
    );

    expect(result.lines).toHaveLength(2);
    assertBalance(result.lines);

    expect(result.lines[0].accountName).toBe('Professional Fees');
    expect(result.lines[0].debit).toBe(400);
    expect(result.lines[0].credit).toBe(0);

    expect(result.lines[1].accountName).toBe('Accrued Liabilities');
    expect(result.lines[1].debit).toBe(0);
    expect(result.lines[1].credit).toBe(400);
  });

  it('5. routes "Paid monthly payroll to employees" → Salaries Expense (Dr) / Bank (Cr)', () => {
    const result = parseTransaction(
      'Paid monthly payroll of 3500 to employees via transfer',
      mockAccounts,
    );

    expect(result.lines).toHaveLength(2);
    const { dr } = assertBalance(result.lines);
    expect(dr).toBe(350000); // 3500.00 in cents

    expect(result.lines[0].accountName).toBe('Salaries Expense');
    expect(result.lines[0].debit).toBe(3500);
    expect(result.lines[0].credit).toBe(0);

    expect(result.lines[1].accountName).toBe('Bank');
    expect(result.lines[1].debit).toBe(0);
    expect(result.lines[1].credit).toBe(3500);
  });

});
