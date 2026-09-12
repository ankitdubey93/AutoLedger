import * as productLineService from './productLineService.js';
import * as reportService from '../ledger-core/reportService.js';
import * as organizationService from '../organizationService.js';
import { monthBounds } from '../../utils/fiscalYear.js';
import { decomposePvm } from '../../utils/uniteconPvm.js';
import { ApiError } from '../../utils/apiError.js';
import type { PvmReport, ProductLineSalesFact, UniteconProductLine } from '../../types/unitecon.js';

/**
 * UnitEcon (Phase 14) — Price-Volume-Mix variance. This file contains ZERO
 * SQL. Its only route into LedgerCore is
 * `reportService.productLineSalesByMonth` (guardrails rule 16).
 *
 * Restricted to the organization's base currency (decision D4):
 * `invoice_lines` carries no `base_*` column, so a foreign-currency line
 * cannot be converted at line grain without re-deriving the rate.
 * `excludedForeignCurrencyInvoices` reports the count rather than hiding it.
 */

export interface PvmResponse {
  baseCurrency: string;
  basePeriod: { from: string; to: string };
  comparePeriod: { from: string; to: string };
  report: PvmReport;
  /** ISSUED invoices in either period in a non-base currency, excluded
   *  because invoice_lines carries no base-currency column. Never hidden. */
  excludedForeignCurrencyInvoices: number;
}

function assertRange(period: { from: string; to: string }): void {
  if (period.from > period.to) throw new ApiError(422, 'from must not be after to');
}

async function collapseToFacts(
  orgId: string,
  baseCurrency: string,
  lines: readonly UniteconProductLine[],
  period: { from: string; to: string },
): Promise<{ facts: ProductLineSalesFact[]; excludedForeignCurrencyInvoices: number }> {
  const accountIds = lines.map((l) => l.revenueAccountId);
  const result = await reportService.productLineSalesByMonth(
    orgId,
    baseCurrency,
    accountIds,
    period.from,
    monthBounds(period.to).endDate,
  );

  const byAccount = new Map<string, UniteconProductLine>(lines.map((l) => [l.revenueAccountId, l]));

  const totalsByLine = new Map<string, { quantityMilli: number; netRevenueCents: number }>();
  for (const row of result.rows) {
    const line = byAccount.get(row.accountId);
    if (line === undefined) continue;
    const existing = totalsByLine.get(line.id);
    if (existing === undefined) {
      totalsByLine.set(line.id, { quantityMilli: row.quantityMilli, netRevenueCents: row.netRevenueCents });
    } else {
      existing.quantityMilli += row.quantityMilli;
      existing.netRevenueCents += row.netRevenueCents;
    }
  }

  const facts: ProductLineSalesFact[] = [];
  for (const line of lines) {
    const totals = totalsByLine.get(line.id);
    if (totals === undefined) continue; // no activity this period — the engine handles the missing side
    facts.push({
      productLineId: line.id,
      productLineName: line.name,
      unitLabel: line.unitLabel,
      quantityMilli: totals.quantityMilli,
      netRevenueCents: totals.netRevenueCents,
    });
  }

  return { facts, excludedForeignCurrencyInvoices: result.excludedForeignCurrencyInvoices };
}

export async function pvmReport(
  orgId: string,
  basePeriod: { from: string; to: string },
  comparePeriod: { from: string; to: string },
): Promise<PvmResponse> {
  assertRange(basePeriod);
  assertRange(comparePeriod);

  const org = await organizationService.getById(orgId);

  const lines = await productLineService.listProductLines(orgId, { includeInactive: false });
  if (lines.length === 0) {
    throw new ApiError(422, 'Configure at least one product line before running a PVM report');
  }

  const baseResult = await collapseToFacts(orgId, org.baseCurrency, lines, basePeriod);
  const compareResult = await collapseToFacts(orgId, org.baseCurrency, lines, comparePeriod);

  const report = decomposePvm(baseResult.facts, compareResult.facts);

  return {
    baseCurrency: org.baseCurrency,
    basePeriod,
    comparePeriod,
    report,
    excludedForeignCurrencyInvoices:
      baseResult.excludedForeignCurrencyInvoices + compareResult.excludedForeignCurrencyInvoices,
  };
}
