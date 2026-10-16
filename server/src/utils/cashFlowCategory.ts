import type { AccountType, BankAccountKind, CashFlowCategory } from '../types/accounting.js';

/**
 * Phase 45 — the cash-flow category of a balance-sheet account.
 *
 * Revenue/Expense accounts return null: they flow through net income, which is
 * the first line of the operating section. Rules, in order: an explicit override
 * wins; a BANK account or the cash control account is CASH; an Asset under
 * 1400 is INVESTING; a Liability under 2500 and any Equity is FINANCING;
 * everything else (including CREDIT_CARD) is OPERATING.
 */
export function deriveCashFlowCategory(input: {
  type: AccountType;
  bankAccountKind: BankAccountKind | null;
  isCashControlAccount: boolean;
  ancestorCodes: readonly string[];
  override: CashFlowCategory | null;
}): CashFlowCategory | null {
  if (input.type === 'Revenue' || input.type === 'Expense') return null;
  if (input.override !== null) return input.override;
  if (input.bankAccountKind === 'BANK' || input.isCashControlAccount) return 'CASH';
  if (input.type === 'Asset' && input.ancestorCodes.includes('1400')) return 'INVESTING';
  if (input.type === 'Liability' && input.ancestorCodes.includes('2500')) return 'FINANCING';
  if (input.type === 'Equity') return 'FINANCING';
  return 'OPERATING';
}
