import * as modelService from './modelService.js';
import * as assumptionService from './assumptionService.js';
import * as organizationService from '../organizationService.js';
import * as reportService from '../ledger-core/reportService.js';
import { monthBounds, monthsBackStart } from '../../utils/fiscalYear.js';
import { projectModel, type Projection, type ProjectionAccount, type ProjectionAssumption } from '../../utils/fpaProjection.js';
import type { FpaScenarioKind } from '../../types/fpa-engine.js';
import type { AccountType } from '../../types/ledger-core.js';

/**
 * FP&A Engine (Phase 12) — assembles a scenario's projection. This file
 * contains ZERO SQL. Every LedgerCore fact it needs arrives through an
 * exported LedgerCore service function — `reportService.monthlyActualsByAccount`,
 * `reportService.resolveControlAccounts`, `reportService.balanceSheet` — and
 * every FP&A fact through this app's own `modelService`/`assumptionService`.
 * That is the whole point of this file: it is the app boundary in practice,
 * mirroring `services/ap-flow/postingService.ts`'s own header ruling for
 * writes, applied here to reads (guardrails rule 16).
 *
 * All reads — no transaction is opened here (guardrails rule 5 governs
 * writes, not reads).
 */

/** The horizon's month starts, 'YYYY-MM-01'. Built with Date.UTC — never `new Date(iso)`. */
export function projectionMonths(startsOn: string, horizonMonths: number): string[] {
  const [yearStr, monthStr] = startsOn.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-12

  const months: string[] = [];
  for (let k = 0; k < horizonMonths; k++) {
    const d = new Date(Date.UTC(year, month - 1 + k, 1));
    months.push(d.toISOString().slice(0, 10));
  }
  return months;
}

export interface ProjectionResponse {
  modelId: string;
  modelName: string;
  scenarioId: string;
  scenarioName: string;
  baseCurrency: string;
  actualsThrough: string;
  /** The trailing months of posted actuals ending at actualsThrough. May be shorter than 12. */
  actuals: { month: string; revenueCents: number; netIncomeCents: number }[];
  projection: Projection;
}

async function assembleProjectionAccountsAndAssumptions(
  orgId: string,
  model: { actualsThrough: string },
  scenarioId: string,
): Promise<{ accounts: ProjectionAccount[]; assumptions: ProjectionAssumption[] }> {
  const fpaAssumptions = await assumptionService.listAssumptions(orgId, scenarioId);

  const baselineEnd = monthBounds(model.actualsThrough).endDate;
  const baselineRows = await reportService.monthlyActualsByAccount(orgId, model.actualsThrough, baselineEnd);

  interface AccountInfo {
    code: string;
    name: string;
    type: AccountType;
    baselineCents: number;
  }
  const byAccountId = new Map<string, AccountInfo>();

  for (const row of baselineRows) {
    if (row.type !== 'Revenue' && row.type !== 'Expense') continue;
    const baselineCents = row.type === 'Revenue' ? row.creditCents - row.debitCents : row.debitCents - row.creditCents;
    byAccountId.set(row.accountId, { code: row.code, name: row.name, type: row.type, baselineCents });
  }

  // Union with assumption accounts that have no baseline activity at all —
  // a FIXED_CENTS assumption on a never-used account still projects.
  for (const assumption of fpaAssumptions) {
    if (!byAccountId.has(assumption.accountId)) {
      byAccountId.set(assumption.accountId, {
        code: assumption.accountCode,
        name: assumption.accountName,
        type: assumption.accountType,
        baselineCents: 0,
      });
    }
  }

  const accounts: ProjectionAccount[] = [...byAccountId.entries()].map(([accountId, info]) => ({
    accountId,
    code: info.code,
    name: info.name,
    type: info.type,
    baselineCents: info.baselineCents,
  }));

  const assumptions: ProjectionAssumption[] = fpaAssumptions.map((a) => ({
    accountId: a.accountId,
    kind: a.kind,
    growthBps: a.growthBps,
    fixedCents: a.fixedCents,
    percentOfRevenueBps: a.percentOfRevenueBps,
  }));

  return { accounts, assumptions };
}

interface OpeningFigures {
  openingCashCents: number;
  openingReceivablesCents: number;
  openingPayablesCents: number;
  openingOtherAssetsCents: number;
  openingOtherLiabilitiesCents: number;
  openingEquityCents: number;
}

async function resolveOpeningFigures(orgId: string, actualsThrough: string): Promise<OpeningFigures> {
  const asOf = monthBounds(actualsThrough).endDate;
  const [sheet, control] = await Promise.all([
    reportService.balanceSheet(orgId, asOf),
    reportService.resolveControlAccounts(orgId),
  ]);

  const openingCashCents =
    sheet.assets.rows.find((r) => r.accountId === control.cashAccountId)?.amountCents ?? 0;
  const openingReceivablesCents =
    sheet.assets.rows.find((r) => r.accountId === control.receivableAccountId)?.amountCents ?? 0;
  const openingOtherAssetsCents = sheet.assets.totalCents - openingCashCents - openingReceivablesCents;

  const openingPayablesCents =
    sheet.liabilities.rows.find((r) => r.accountId === control.payableAccountId)?.amountCents ?? 0;
  const openingOtherLiabilitiesCents = sheet.liabilities.totalCents - openingPayablesCents;

  // equity.totalCents already includes derived retained + current earnings
  // (reportService.balanceSheet's own header) — do not add them again.
  const openingEquityCents = sheet.equity.totalCents;

  return {
    openingCashCents,
    openingReceivablesCents,
    openingPayablesCents,
    openingOtherAssetsCents,
    openingOtherLiabilitiesCents,
    openingEquityCents,
  };
}

export async function buildProjection(orgId: string, scenarioId: string): Promise<ProjectionResponse> {
  const scenario = await modelService.getScenarioById(orgId, scenarioId);
  const model = await modelService.getModelById(orgId, scenario.modelId);
  const org = await organizationService.getById(orgId);

  const { accounts, assumptions } = await assembleProjectionAccountsAndAssumptions(orgId, model, scenarioId);
  const openings = await resolveOpeningFigures(orgId, model.actualsThrough);

  // Trailing 12 months of actuals, folded into a per-month {revenue, netIncome}.
  const trailingStart = monthsBackStart(model.actualsThrough, 12);
  const trailingEnd = monthBounds(model.actualsThrough).endDate;
  const trailingRows = await reportService.monthlyActualsByAccount(orgId, trailingStart, trailingEnd);

  const actualsByMonth = new Map<string, { revenueCents: number; netIncomeCents: number }>();
  for (const row of trailingRows) {
    const entry = actualsByMonth.get(row.month) ?? { revenueCents: 0, netIncomeCents: 0 };
    if (row.type === 'Revenue') {
      const net = row.creditCents - row.debitCents;
      entry.revenueCents += net;
      entry.netIncomeCents += net;
    } else if (row.type === 'Expense') {
      entry.netIncomeCents -= row.debitCents - row.creditCents;
    }
    actualsByMonth.set(row.month, entry);
  }
  const actuals = [...actualsByMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, v]) => ({ month, revenueCents: v.revenueCents, netIncomeCents: v.netIncomeCents }));

  const projection = projectModel({
    months: projectionMonths(model.startsOn, model.horizonMonths),
    accounts,
    assumptions,
    ...openings,
    dsoDays: scenario.dsoDays,
    dpoDays: scenario.dpoDays,
    taxRateBps: scenario.taxRateBps,
  });

  return {
    modelId: model.id,
    modelName: model.name,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    baseCurrency: org.baseCurrency,
    actualsThrough: model.actualsThrough,
    actuals,
    projection,
  };
}

export interface ScenarioSummary {
  scenarioId: string;
  scenarioName: string;
  kind: FpaScenarioKind;
  isDefault: boolean;
  runwayMonths: number | null;
  cashOutMonth: string | null;
  closingCashCents: number;
  totalRevenueCents: number;
  totalNetIncomeCents: number;
  balances: boolean;
}

export async function compareScenarios(
  orgId: string,
  modelId: string,
): Promise<{ modelId: string; modelName: string; baseCurrency: string; scenarios: ScenarioSummary[] }> {
  const model = await modelService.getModelById(orgId, modelId);
  const org = await organizationService.getById(orgId);

  const scenarios: ScenarioSummary[] = [];
  // Sequential, not Promise.all — each projection issues several queries,
  // and a wide model should not burst the pool with concurrent connections
  // for a latency win not worth the risk.
  for (const scenario of model.scenarios) {
    const response = await buildProjection(orgId, scenario.id);
    const lastMonth = response.projection.months[response.projection.months.length - 1];

    let totalRevenueCents = 0;
    let totalNetIncomeCents = 0;
    for (const month of response.projection.months) {
      totalRevenueCents += month.incomeStatement.revenueCents;
      totalNetIncomeCents += month.incomeStatement.netIncomeCents;
    }

    scenarios.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      kind: scenario.kind,
      isDefault: scenario.isDefault,
      runwayMonths: response.projection.runwayMonths,
      cashOutMonth: response.projection.cashOutMonth,
      closingCashCents: lastMonth?.cashFlow.closingCashCents ?? 0,
      totalRevenueCents,
      totalNetIncomeCents,
      balances: response.projection.balances,
    });
  }

  return { modelId: model.id, modelName: model.name, baseCurrency: org.baseCurrency, scenarios };
}
