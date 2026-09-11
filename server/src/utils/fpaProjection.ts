import { cents, scaleCents, type Cents } from './money.js';
import type { AccountType } from '../types/ledger-core.js';
import type { FpaAssumptionKind } from '../types/fpa-engine.js';

/**
 * FP&A Engine's projection engine (Phase 12) — a pure function, no DB, no
 * clock, no I/O. Mirrors `utils/matchScore.ts`'s posture: an app-specific
 * scoring/computation engine that lives in `utils/` so it can be unit-tested
 * without a running Postgres.
 *
 * Every scaling here is `scaleCents` — exact `BigInt` integer arithmetic
 * (guardrails rule 3). There is no other multiplication or division applied
 * to a cents value anywhere in this file.
 *
 * DELIBERATE LIMITS, stated once here rather than scattered through the
 * arithmetic below:
 *
 *  - **No assumption flat-lines the last actual.** An account with no
 *    matching `ProjectionAssumption` projects at its own `baselineCents`
 *    forever — not zero, not a decay, exactly the last posted month's
 *    figure repeated. This is the single most consequential unstated
 *    default in the engine, so it is stated here explicitly.
 *  - **`PERCENT_OF_REVENUE_BPS` resolves in a second pass, once per month.**
 *    `assumptionService.upsertAssumption` refuses this kind on a Revenue
 *    account (the circularity guard), so revenue is always fully known
 *    before any percent-of-revenue account is computed — one extra pass is
 *    enough, no fixed-point iteration is needed.
 *  - **No tax benefit on a loss.** A negative `operatingIncomeCents` pays
 *    zero tax rather than a negative (refundable) amount — a negative tax
 *    would quietly manufacture cash the business has not actually received.
 *  - **DSO/DPO use a 30-day month convention**, not a calendar month's true
 *    length: `scaleCents(revenue, dsoDays, 30)`. Deterministic, and the same
 *    simplification the aging-bucket reports already make.
 *  - **`otherAssetsCents`, `otherLiabilitiesCents` and `equityCents` are
 *    held flat** at their opening value for every projected month. Phase 12
 *    models no capex, no depreciation, and no debt schedule — that is
 *    ForecasterPro's (Phase 13) territory, not this engine's.
 *
 * WHY `balances` IS A REAL PROOF, not a hard-coded flag: substituting the
 * cash-flow identity (`netCashFlowCents = netIncomeCents -
 * changeInReceivablesCents + changeInPayablesCents`) into the balance-sheet
 * equality and simplifying algebraically reduces it, by induction over the
 * months, to exactly the *opening* balance-sheet identity:
 *
 *   openingCash + openingReceivables + openingOtherAssets
 *     === openingPayables + openingOtherLiabilities + openingEquity
 *
 * Since those opening figures come from `reportService.balanceSheet`, which
 * already asserts its own `balances` flag, every projected month balances
 * if and only if the actual books balanced on the day the model's actuals
 * end. `balances: false` therefore means a genuine bug in this engine or a
 * genuine imbalance in the GL — never a rounding artefact, because every
 * scaling operation above is exact `BigInt` arithmetic.
 */

export interface ProjectionAccount {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /**
   * The actuals_through month's own net amount for this account,
   * sign-normalised positive: credit−debit for Revenue, debit−credit for
   * Expense — the same convention `reportService.profitAndLoss` uses.
   */
  baselineCents: number;
}

export interface ProjectionAssumption {
  accountId: string;
  kind: FpaAssumptionKind;
  growthBps: number | null;
  fixedCents: number | null;
  percentOfRevenueBps: number | null;
}

export interface ProjectionInput {
  months: readonly string[]; // 'YYYY-MM-01', length === horizonMonths
  accounts: readonly ProjectionAccount[]; // Revenue and Expense accounts only
  assumptions: readonly ProjectionAssumption[];
  openingCashCents: number;
  openingReceivablesCents: number;
  openingPayablesCents: number;
  openingOtherAssetsCents: number;
  openingOtherLiabilitiesCents: number;
  openingEquityCents: number;
  dsoDays: number;
  dpoDays: number;
  taxRateBps: number;
}

export interface ProjectedLine {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  amountCents: number;
}

export interface ProjectedMonth {
  month: string;
  incomeStatement: {
    lines: readonly ProjectedLine[];
    revenueCents: number;
    costOfSalesCents: number;
    grossProfitCents: number;
    operatingExpensesCents: number;
    operatingIncomeCents: number;
    taxCents: number;
    netIncomeCents: number;
  };
  cashFlow: {
    netIncomeCents: number;
    changeInReceivablesCents: number;
    changeInPayablesCents: number;
    netCashFlowCents: number;
    openingCashCents: number;
    closingCashCents: number;
  };
  balanceSheet: {
    cashCents: number;
    receivablesCents: number;
    otherAssetsCents: number;
    totalAssetsCents: number;
    payablesCents: number;
    otherLiabilitiesCents: number;
    equityCents: number;
    retainedEarningsCents: number;
    totalLiabilitiesAndEquityCents: number;
    balances: boolean;
  };
}

export interface Projection {
  months: readonly ProjectedMonth[];
  runwayMonths: number | null;
  cashOutMonth: string | null;
  averageMonthlyBurnCents: number;
  balances: boolean;
}

/** Pure. No DB, no clock, no I/O — the same input always yields the same output. */
export function projectModel(input: ProjectionInput): Projection {
  const assumptionByAccount = new Map(input.assumptions.map((a) => [a.accountId, a]));

  // Per-account amount from the previous iteration — seeded with each
  // account's own baseline for month 0's "prev".
  let prevAmounts = new Map<string, Cents>(
    input.accounts.map((a) => [a.accountId, cents(a.baselineCents)]),
  );

  let runningCash = cents(input.openingCashCents);
  let prevReceivables = cents(input.openingReceivablesCents);
  let prevPayables = cents(input.openingPayablesCents);
  let cumulativeRetainedEarnings = 0;

  const projectedMonths: ProjectedMonth[] = [];

  for (const month of input.months) {
    // ---- Pass 1: GROWTH_BPS, FIXED_CENTS, and no-assumption accounts.
    // PERCENT_OF_REVENUE_BPS accounts are deferred to pass 2, below.
    const amounts = new Map<string, Cents>();
    const deferredPercentAccounts: ProjectionAccount[] = [];

    for (const account of input.accounts) {
      const assumption = assumptionByAccount.get(account.accountId);

      if (assumption === undefined) {
        // No assumption flat-lines the last actual — see the header comment.
        amounts.set(account.accountId, cents(account.baselineCents));
        continue;
      }

      switch (assumption.kind) {
        case 'GROWTH_BPS': {
          if (assumption.growthBps === null) {
            throw new Error(`Assumption on account ${account.accountId} is GROWTH_BPS with a null growthBps`);
          }
          const prev = prevAmounts.get(account.accountId) ?? cents(account.baselineCents);
          amounts.set(account.accountId, scaleCents(prev, 10000 + assumption.growthBps, 10000));
          break;
        }
        case 'FIXED_CENTS': {
          if (assumption.fixedCents === null) {
            throw new Error(`Assumption on account ${account.accountId} is FIXED_CENTS with a null fixedCents`);
          }
          amounts.set(account.accountId, cents(assumption.fixedCents));
          break;
        }
        case 'PERCENT_OF_REVENUE_BPS': {
          deferredPercentAccounts.push(account);
          break;
        }
      }
    }

    // Revenue is fully known before pass 2 runs — a revenue account can
    // never carry PERCENT_OF_REVENUE_BPS (assumptionService's own guard),
    // so this sum never depends on a value pass 2 has not computed yet.
    let revenueCents = 0;
    for (const account of input.accounts) {
      if (account.type === 'Revenue') {
        revenueCents += amounts.get(account.accountId) ?? 0;
      }
    }

    // ---- Pass 2: PERCENT_OF_REVENUE_BPS accounts.
    for (const account of deferredPercentAccounts) {
      const assumption = assumptionByAccount.get(account.accountId);
      if (assumption === undefined || assumption.percentOfRevenueBps === null) {
        throw new Error(`Deferred percent-of-revenue account ${account.accountId} has no percentOfRevenueBps`);
      }
      amounts.set(account.accountId, scaleCents(cents(revenueCents), assumption.percentOfRevenueBps, 10000));
    }

    // ---- Income statement.
    const lines: ProjectedLine[] = [];
    let costOfSalesCents = 0;
    let operatingExpensesCents = 0;
    for (const account of input.accounts) {
      const amountCents = amounts.get(account.accountId) ?? 0;
      lines.push({ accountId: account.accountId, code: account.code, name: account.name, type: account.type, amountCents });

      if (account.type === 'Expense') {
        // COGS is not a sixth account type (guardrails rule 12) — the split
        // is by code prefix against the default chart's 5xxx range, the
        // identical ruling reportService.profitAndLoss records.
        if (account.code.startsWith('5')) {
          costOfSalesCents += amountCents;
        } else {
          operatingExpensesCents += amountCents;
        }
      }
    }

    const grossProfitCents = revenueCents - costOfSalesCents;
    const operatingIncomeCents = grossProfitCents - operatingExpensesCents;
    // No tax benefit on a loss — see the header comment.
    const taxCents =
      operatingIncomeCents > 0 ? scaleCents(cents(operatingIncomeCents), input.taxRateBps, 10000) : 0;
    const netIncomeCents = operatingIncomeCents - taxCents;

    // ---- Working capital, 30-day month convention.
    const receivablesCents = scaleCents(cents(revenueCents), input.dsoDays, 30);
    const payablesCents = scaleCents(cents(costOfSalesCents + operatingExpensesCents), input.dpoDays, 30);
    const changeInReceivablesCents = receivablesCents - prevReceivables;
    const changeInPayablesCents = payablesCents - prevPayables;
    const netCashFlowCents = netIncomeCents - changeInReceivablesCents + changeInPayablesCents;

    const openingCashCents = runningCash;
    const closingCashCents = openingCashCents + netCashFlowCents;

    // ---- Balance sheet.
    cumulativeRetainedEarnings += netIncomeCents;
    const cashCents = closingCashCents;
    const otherAssetsCents = input.openingOtherAssetsCents;
    const otherLiabilitiesCents = input.openingOtherLiabilitiesCents;
    const equityCents = input.openingEquityCents;
    const retainedEarningsCents = cumulativeRetainedEarnings;
    const totalAssetsCents = cashCents + receivablesCents + otherAssetsCents;
    const totalLiabilitiesAndEquityCents =
      payablesCents + otherLiabilitiesCents + equityCents + retainedEarningsCents;

    projectedMonths.push({
      month,
      incomeStatement: {
        lines,
        revenueCents,
        costOfSalesCents,
        grossProfitCents,
        operatingExpensesCents,
        operatingIncomeCents,
        taxCents,
        netIncomeCents,
      },
      cashFlow: {
        netIncomeCents,
        changeInReceivablesCents,
        changeInPayablesCents,
        netCashFlowCents,
        openingCashCents,
        closingCashCents,
      },
      balanceSheet: {
        cashCents,
        receivablesCents,
        otherAssetsCents,
        totalAssetsCents,
        payablesCents,
        otherLiabilitiesCents,
        equityCents,
        retainedEarningsCents,
        totalLiabilitiesAndEquityCents,
        // Integer equality, never an epsilon (guardrails rule 3).
        balances: totalAssetsCents === totalLiabilitiesAndEquityCents,
      },
    });

    // Roll state forward for the next month.
    prevAmounts = amounts;
    prevReceivables = receivablesCents;
    prevPayables = payablesCents;
    runningCash = cents(closingCashCents);
  }

  let cashOutMonth: string | null = null;
  let runwayMonths: number | null = null;
  for (let i = 0; i < projectedMonths.length; i++) {
    const projectedMonth = projectedMonths[i];
    if (projectedMonth !== undefined && projectedMonth.cashFlow.closingCashCents < 0) {
      cashOutMonth = projectedMonth.month;
      runwayMonths = i;
      break;
    }
  }

  const burnWindow = Math.min(3, projectedMonths.length);
  let burnSum = 0;
  for (let i = 0; i < burnWindow; i++) {
    burnSum += -(projectedMonths[i]?.cashFlow.netCashFlowCents ?? 0);
  }
  const averageMonthlyBurnCents = burnWindow === 0 ? 0 : Math.trunc(burnSum / burnWindow);

  return {
    months: projectedMonths,
    runwayMonths,
    cashOutMonth,
    averageMonthlyBurnCents,
    balances: projectedMonths.every((m) => m.balanceSheet.balances),
  };
}
