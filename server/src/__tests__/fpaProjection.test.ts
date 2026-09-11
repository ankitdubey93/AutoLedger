import { describe, expect, it } from 'vitest';
import { projectModel, type ProjectionAccount, type ProjectionAssumption, type ProjectionInput } from '../utils/fpaProjection.js';

/** Unit tier — no database. Pure arithmetic, no createApp, no resetTables, no pool. */

function baseInput(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    months: ['2026-10-01', '2026-11-01', '2026-12-01'],
    accounts: [],
    assumptions: [],
    openingCashCents: 0,
    openingReceivablesCents: 0,
    openingPayablesCents: 0,
    openingOtherAssetsCents: 0,
    openingOtherLiabilitiesCents: 0,
    openingEquityCents: 0,
    dsoDays: 0,
    dpoDays: 0,
    taxRateBps: 0,
    ...overrides,
  };
}

function revenueAccount(id: string, baselineCents: number, code = '4100'): ProjectionAccount {
  return { accountId: id, code, name: 'Revenue', type: 'Revenue', baselineCents };
}

function expenseAccount(id: string, baselineCents: number, code = '6100'): ProjectionAccount {
  return { accountId: id, code, name: 'Expense', type: 'Expense', baselineCents };
}

/** Monthly 'YYYY-MM-01' labels starting at 2026-10, rolling over into 2027. */
function monthsFrom(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const month = 10 + i; // 1-based, October = 10
    const year = 2026 + Math.floor((month - 1) / 12);
    const normalizedMonth = ((month - 1) % 12) + 1;
    return `${String(year)}-${String(normalizedMonth).padStart(2, '0')}-01`;
  });
}

describe('projectModel', () => {
  it('1. GROWTH_BPS compounds exactly', () => {
    const input = baseInput({
      accounts: [revenueAccount('a', 100_000)],
      assumptions: [
        { accountId: 'a', kind: 'GROWTH_BPS', growthBps: 1000, fixedCents: null, percentOfRevenueBps: null },
      ],
    });
    const result = projectModel(input);
    expect(result.months[0]?.incomeStatement.revenueCents).toBe(110000);
    expect(result.months[1]?.incomeStatement.revenueCents).toBe(121000);
    expect(result.months[2]?.incomeStatement.revenueCents).toBe(133100);
  });

  it('2. FIXED_CENTS ignores the baseline', () => {
    const input = baseInput({
      accounts: [expenseAccount('a', 999_999)],
      assumptions: [
        { accountId: 'a', kind: 'FIXED_CENTS', growthBps: null, fixedCents: 50_000, percentOfRevenueBps: null },
      ],
    });
    const result = projectModel(input);
    for (const month of result.months) {
      expect(month.incomeStatement.operatingExpensesCents).toBe(50000);
    }
  });

  it('3. PERCENT_OF_REVENUE_BPS resolves after revenue', () => {
    const input = baseInput({
      accounts: [revenueAccount('rev', 1_000_000), expenseAccount('exp', 0)],
      assumptions: [
        { accountId: 'exp', kind: 'PERCENT_OF_REVENUE_BPS', growthBps: null, fixedCents: null, percentOfRevenueBps: 2500 },
      ],
    });
    const result = projectModel(input);
    for (const month of result.months) {
      expect(month.incomeStatement.operatingExpensesCents).toBe(250000);
    }
  });

  it('4. no assumption flat-lines the baseline', () => {
    const input = baseInput({ accounts: [expenseAccount('a', 33_333)] });
    const result = projectModel(input);
    for (const month of result.months) {
      expect(month.incomeStatement.operatingExpensesCents).toBe(33333);
    }
  });

  it('5. COGS splits by code prefix', () => {
    const input = baseInput({
      accounts: [expenseAccount('cogs', 100_000, '5010'), expenseAccount('opex', 100_000, '6010')],
    });
    const result = projectModel(input);
    const month = result.months[0];
    expect(month?.incomeStatement.costOfSalesCents).toBe(100000);
    expect(month?.incomeStatement.operatingExpensesCents).toBe(100000);
    expect(month?.incomeStatement.grossProfitCents).toBe((month?.incomeStatement.revenueCents ?? 0) - 100000);
  });

  it('6. no tax benefit on a loss', () => {
    const input = baseInput({
      accounts: [expenseAccount('exp', 100_000)],
      taxRateBps: 2500,
    });
    const result = projectModel(input);
    const month = result.months[0];
    expect(month?.incomeStatement.operatingIncomeCents).toBe(-100000);
    expect(month?.incomeStatement.taxCents).toBe(0);
    expect(month?.incomeStatement.netIncomeCents).toBe(-100000);
  });

  it('7. tax applies to a profit', () => {
    const input = baseInput({
      accounts: [revenueAccount('rev', 1_000_000)],
      taxRateBps: 2500,
    });
    const result = projectModel(input);
    const month = result.months[0];
    expect(month?.incomeStatement.taxCents).toBe(250000);
    expect(month?.incomeStatement.netIncomeCents).toBe(750000);
  });

  it('8. DSO builds receivables and consumes cash in month 0, steady in month 1', () => {
    const input = baseInput({
      accounts: [revenueAccount('rev', 300_000)],
      dsoDays: 30,
    });
    const result = projectModel(input);
    const month0 = result.months[0];
    const month1 = result.months[1];
    expect(month0?.balanceSheet.receivablesCents).toBe(300000);
    expect(month0?.cashFlow.changeInReceivablesCents).toBe(300000);
    expect(month0?.cashFlow.netCashFlowCents).toBe((month0?.incomeStatement.netIncomeCents ?? 0) - 300000);
    expect(month1?.cashFlow.changeInReceivablesCents).toBe(0);
  });

  it('9. every month balances when the opening sheet balances', () => {
    const months = monthsFrom(12);

    const accounts: ProjectionAccount[] = [
      revenueAccount('rev', 1_000_000, '4100'),
      expenseAccount('cogs', 0, '5100'),
      expenseAccount('opex', 0, '6100'),
    ];
    const assumptions: ProjectionAssumption[] = [
      { accountId: 'rev', kind: 'GROWTH_BPS', growthBps: 500, fixedCents: null, percentOfRevenueBps: null },
      { accountId: 'cogs', kind: 'PERCENT_OF_REVENUE_BPS', growthBps: null, fixedCents: null, percentOfRevenueBps: 3000 },
      { accountId: 'opex', kind: 'FIXED_CENTS', growthBps: null, fixedCents: 200_000, percentOfRevenueBps: null },
    ];

    // 500,000 + 200,000 + 300,000 === 150,000 + 50,000 + 800,000
    const input = baseInput({
      months,
      accounts,
      assumptions,
      openingCashCents: 500_000,
      openingReceivablesCents: 200_000,
      openingOtherAssetsCents: 300_000,
      openingPayablesCents: 150_000,
      openingOtherLiabilitiesCents: 50_000,
      openingEquityCents: 800_000,
      dsoDays: 45,
      dpoDays: 30,
      taxRateBps: 2500,
    });

    const result = projectModel(input);
    expect(result.balances).toBe(true);
    for (const month of result.months) {
      expect(month.balanceSheet.balances).toBe(true);
    }

    const midMonth = result.months[5];
    expect(midMonth).toBeDefined();
    expect(midMonth?.balanceSheet.totalAssetsCents).toBe(midMonth?.balanceSheet.totalLiabilitiesAndEquityCents);
  });

  it('10. the invariant fails loudly on a broken opening sheet', () => {
    const accounts: ProjectionAccount[] = [
      revenueAccount('rev', 1_000_000, '4100'),
      expenseAccount('opex', 0, '6100'),
    ];
    const assumptions: ProjectionAssumption[] = [
      { accountId: 'rev', kind: 'GROWTH_BPS', growthBps: 500, fixedCents: null, percentOfRevenueBps: null },
      { accountId: 'opex', kind: 'FIXED_CENTS', growthBps: null, fixedCents: 200_000, percentOfRevenueBps: null },
    ];

    const input = baseInput({
      accounts,
      assumptions,
      openingCashCents: 500_000,
      openingReceivablesCents: 200_000,
      openingOtherAssetsCents: 300_000,
      openingPayablesCents: 150_000,
      openingOtherLiabilitiesCents: 50_000,
      // Off by exactly 1 vs. case 9's balanced 800_000.
      openingEquityCents: 799_999,
      dsoDays: 45,
      dpoDays: 30,
      taxRateBps: 2500,
    });

    const result = projectModel(input);
    expect(result.balances).toBe(false);
  });

  it('11. runway found — closing cash goes negative in month 1', () => {
    const input = baseInput({
      months: monthsFrom(6),
      accounts: [expenseAccount('opex', 60_000)],
      openingCashCents: 100_000,
    });
    const result = projectModel(input);
    expect(result.runwayMonths).toBe(1);
    expect(result.cashOutMonth).toBe(result.months[1]?.month);
    expect(result.months[0]?.cashFlow.closingCashCents).toBe(40000);
    expect(result.months[1]?.cashFlow.closingCashCents).toBe(-20000);
  });

  it('12. runway absent — cash never goes negative', () => {
    const input = baseInput({
      months: monthsFrom(6),
      accounts: [expenseAccount('opex', 1_000)],
      openingCashCents: 10_000_000,
    });
    const result = projectModel(input);
    expect(result.runwayMonths).toBeNull();
    expect(result.cashOutMonth).toBeNull();
  });

  it('13. averageMonthlyBurnCents over the first three months', () => {
    const input = baseInput({
      months: monthsFrom(6),
      accounts: [expenseAccount('opex', 60_000)],
      openingCashCents: 100_000,
    });
    const result = projectModel(input);
    expect(result.averageMonthlyBurnCents).toBe(60000);
  });

  it('14. determinism — same input yields deeply equal output and is not mutated', () => {
    const input = baseInput({
      accounts: [revenueAccount('rev', 100_000)],
      assumptions: [
        { accountId: 'rev', kind: 'GROWTH_BPS', growthBps: 200, fixedCents: null, percentOfRevenueBps: null },
      ],
    });
    const snapshot = structuredClone(input);

    const first = projectModel(input);
    const second = projectModel(input);

    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
  });

  it('15. empty accounts projects zeros and still balances', () => {
    const input = baseInput({ accounts: [], assumptions: [] });
    const result = projectModel(input);
    for (const month of result.months) {
      expect(month.incomeStatement.revenueCents).toBe(0);
      expect(month.incomeStatement.netIncomeCents).toBe(0);
      expect(month.cashFlow.netCashFlowCents).toBe(0);
    }
    expect(result.balances).toBe(true);
  });
});
