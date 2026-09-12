import * as cohortService from './cohortService.js';
import * as settingsService from './settingsService.js';
import * as reportService from '../ledger-core/reportService.js';
import { monthBounds } from '../../utils/fiscalYear.js';
import { cents, divideCents, scaleCents } from '../../utils/money.js';
import type { UnitEconomicsReport, UnitEconomicsRow } from '../../types/unitecon.js';

/**
 * UnitEcon (Phase 14) — LTV/CAC unit economics. This file contains ZERO SQL.
 * Its only route into LedgerCore is `reportService.monthlyActualsByAccount`
 * (guardrails rule 16), read only when at least one acquisition account is
 * configured.
 *
 * LTV here is OBSERVED cumulative gross margin per acquired customer through
 * the end of the requested window — not a modelled lifetime. There is no
 * churn rate and no extrapolation (decision D13).
 */

export async function unitEconomics(orgId: string, from: string, to: string): Promise<UnitEconomicsReport> {
  const { matrix, baseCurrency } = await cohortService.cohortMatrix(orgId, from, to);
  const settings = await settingsService.getSettings(orgId);

  const spendByMonth = new Map<string, number>();
  if (settings.acquisitionAccountIds.length > 0) {
    const accountIdSet = new Set(settings.acquisitionAccountIds);
    const actuals = await reportService.monthlyActualsByAccount(orgId, from, monthBounds(to).endDate);
    for (const row of actuals) {
      if (!accountIdSet.has(row.accountId)) continue;
      // Expense accounts are debit-normal.
      const netDebit = row.debitCents - row.creditCents;
      spendByMonth.set(row.month, (spendByMonth.get(row.month) ?? 0) + netDebit);
    }
  }

  const rows: UnitEconomicsRow[] = matrix.rows.map((row) => {
    const newCustomers = row.cohortSize;
    const acquisitionSpendCents = spendByMonth.get(row.cohortMonth) ?? 0;
    const cacCents = newCustomers === 0 ? null : divideCents(cents(acquisitionSpendCents), newCustomers);

    const cumulativeRevenueCents = row.cells.reduce((sum, cell) => sum + cell.netRevenueCents, 0);
    const cumulativeGrossMarginCents = scaleCents(
      cents(cumulativeRevenueCents),
      settings.grossMarginBps,
      10000,
    );
    const ltvCents =
      newCustomers === 0 ? null : divideCents(cents(cumulativeGrossMarginCents), newCustomers);

    // Exact BigInt division, not `Math.round((ltvCents * 10000) / cacCents)`:
    // both operands are money in cents, and `scaleCents`/`divideCents`'s own
    // reasoning applies here too — a float division of two Cents values is
    // never the way to derive a ratio from them, even though in practice a
    // per-cohort LTV/CAC figure stays far inside the safe-integer range.
    const ltvToCacBps =
      ltvCents === null || cacCents === null || cacCents <= 0
        ? null
        : Number((BigInt(ltvCents) * 10000n + BigInt(cacCents) / 2n) / BigInt(cacCents));

    let paybackMonths: number | null = null;
    if (cacCents !== null && cacCents > 0) {
      let runningRevenue = 0;
      for (const cell of row.cells) {
        runningRevenue += cell.netRevenueCents;
        const perCustomerMargin = divideCents(
          scaleCents(cents(runningRevenue), settings.grossMarginBps, 10000),
          newCustomers,
        );
        if (perCustomerMargin >= cacCents) {
          paybackMonths = cell.offset;
          break;
        }
      }
    }

    return {
      cohortMonth: row.cohortMonth,
      newCustomers,
      acquisitionSpendCents,
      cacCents,
      cumulativeRevenueCents,
      cumulativeGrossMarginCents,
      ltvCents,
      ltvToCacBps,
      paybackMonths,
      observedMonths: row.cells.length,
    };
  });

  const totalNewCustomers = matrix.totalNewCustomers;
  const totalAcquisitionSpendCents = rows.reduce((sum, r) => sum + r.acquisitionSpendCents, 0);
  const blendedCacCents =
    totalNewCustomers === 0 ? null : divideCents(cents(totalAcquisitionSpendCents), totalNewCustomers);

  return {
    baseCurrency,
    from,
    to,
    grossMarginBps: settings.grossMarginBps,
    acquisitionAccountIds: settings.acquisitionAccountIds,
    rows,
    totalNewCustomers,
    totalAcquisitionSpendCents,
    blendedCacCents,
  };
}
