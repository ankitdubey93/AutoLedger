import { describe, expect, it } from 'vitest';
import { deriveBalanceSheetClass } from '../utils/balanceSheetClass.js';
import type { AccountType, BalanceSheetClass } from '../types/accounting.js';

function derive(
  type: AccountType,
  ancestorCodes: string[],
  override: BalanceSheetClass | null = null,
): BalanceSheetClass | null {
  return deriveBalanceSheetClass({ type, ancestorCodes, override });
}

describe('deriveBalanceSheetClass', () => {
  it('prepaid under 1100 is current', () => {
    expect(derive('Asset', ['1100', '1000'])).toBe('CURRENT');
  });
  it('equipment under 1400 is non-current', () => {
    expect(derive('Asset', ['1400', '1000'])).toBe('NON_CURRENT');
  });
  it('notes payable under 2500 is non-current', () => {
    expect(derive('Liability', ['2500', '2000'])).toBe('NON_CURRENT');
  });
  it('accounts payable under 2010 is current', () => {
    expect(derive('Liability', ['2010', '2000'])).toBe('CURRENT');
  });
  it('root-level credit card is current', () => {
    expect(derive('Liability', [])).toBe('CURRENT');
  });
  it('override wins', () => {
    expect(derive('Asset', ['1400', '1000'], 'CURRENT')).toBe('CURRENT');
  });
  it('equity has no class', () => {
    expect(derive('Equity', ['3000'])).toBeNull();
  });
  it('revenue ignores an override', () => {
    expect(derive('Revenue', ['4000'], 'CURRENT')).toBeNull();
  });
});
