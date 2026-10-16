import { describe, expect, it } from 'vitest';
import { deriveCashFlowCategory } from '../utils/cashFlowCategory.js';
import type { AccountType, BankAccountKind, CashFlowCategory } from '../types/accounting.js';

function derive(
  type: AccountType,
  extra: {
    bankAccountKind?: BankAccountKind | null;
    isCashControlAccount?: boolean;
    ancestorCodes?: string[];
    override?: CashFlowCategory | null;
  } = {},
): CashFlowCategory | null {
  return deriveCashFlowCategory({
    type,
    bankAccountKind: extra.bankAccountKind ?? null,
    isCashControlAccount: extra.isCashControlAccount ?? false,
    ancestorCodes: extra.ancestorCodes ?? [],
    override: extra.override ?? null,
  });
}

describe('deriveCashFlowCategory', () => {
  it('returns null for an Expense', () => {
    expect(derive('Expense')).toBeNull();
  });
  it('lets an override win', () => {
    expect(derive('Asset', { ancestorCodes: ['1000', '1400'], override: 'OPERATING' })).toBe('OPERATING');
  });
  it('treats a BANK account as CASH', () => {
    expect(derive('Asset', { bankAccountKind: 'BANK' })).toBe('CASH');
  });
  it('treats the cash control account as CASH', () => {
    expect(derive('Asset', { isCashControlAccount: true })).toBe('CASH');
  });
  it('treats a CREDIT_CARD liability as OPERATING', () => {
    expect(derive('Liability', { bankAccountKind: 'CREDIT_CARD', ancestorCodes: ['2000', '2100'] })).toBe('OPERATING');
  });
  it('treats an Asset under 1400 as INVESTING', () => {
    expect(derive('Asset', { ancestorCodes: ['1000', '1400'] })).toBe('INVESTING');
  });
  it('treats a Liability under 2500 as FINANCING', () => {
    expect(derive('Liability', { ancestorCodes: ['2000', '2500'] })).toBe('FINANCING');
  });
  it('treats Equity as FINANCING', () => {
    expect(derive('Equity', { ancestorCodes: ['3000'] })).toBe('FINANCING');
  });
  it('treats an Asset under 1100 as OPERATING', () => {
    expect(derive('Asset', { ancestorCodes: ['1000', '1100'] })).toBe('OPERATING');
  });
});
