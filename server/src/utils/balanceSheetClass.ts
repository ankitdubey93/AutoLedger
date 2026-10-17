import type { AccountType, BalanceSheetClass } from '../types/accounting.js';

/**
 * Phase 47 — the current/non-current class of a balance-sheet account.
 * Equity, Revenue and Expense return null. Rules, in order: an explicit
 * override wins; an Asset under 1400 or a Liability under 2500 is
 * NON_CURRENT; every other Asset/Liability (including a root-level credit
 * card) is CURRENT. `ancestorCodes` excludes the account's own code.
 */
export function deriveBalanceSheetClass(input: {
  type: AccountType;
  ancestorCodes: readonly string[];
  override: BalanceSheetClass | null;
}): BalanceSheetClass | null {
  if (input.type !== 'Asset' && input.type !== 'Liability') return null;
  if (input.override !== null) return input.override;
  if (input.type === 'Asset' && input.ancestorCodes.includes('1400')) return 'NON_CURRENT';
  if (input.type === 'Liability' && input.ancestorCodes.includes('2500')) return 'NON_CURRENT';
  return 'CURRENT';
}
