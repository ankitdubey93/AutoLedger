import * as planService from './planService.js';
import * as driverService from './driverService.js';
import * as forecastLineService from './forecastLineService.js';
import * as headcountService from './headcountService.js';
import * as organizationService from '../organizationService.js';
import * as accountService from '../ledger-core/accountService.js';
import { buildForecast, type BuildRole, type ForecastBuild } from '../../utils/forecasterBuild.js';
import type { AccountType } from '../../types/ledger-core.js';

/**
 * ForecasterPro (Phase 13) — assembles a plan's forecast build-up. This file
 * contains ZERO SQL. Every ForecasterPro fact arrives through this app's own
 * `planService`/`driverService`/`forecastLineService`/`headcountService`,
 * and every LedgerCore fact through `accountService`'s exported functions
 * and `organizationService.getById` — never a direct query. That is the
 * whole point of this file: it is the app boundary in practice, mirroring
 * `services/fpa-engine/forecastService.ts`'s own header ruling
 * (guardrails rule 16).
 *
 * All reads — no transaction is opened here (guardrails rule 5 governs
 * writes, not reads).
 */

export interface ForecastResponse {
  planId: string;
  planName: string;
  baseCurrency: string;
  startsOn: string;
  horizonMonths: number;
  actualsThrough: string;
  accounts: { accountId: string; code: string; name: string; type: AccountType }[];
  build: ForecastBuild;
}

export async function buildPlanForecast(orgId: string, planId: string): Promise<ForecastResponse> {
  const plan = await planService.getPlanById(orgId, planId);
  const org = await organizationService.getById(orgId);

  const months = planService.planMonths(plan.startsOn, plan.horizonMonths);
  const driverValues = await driverService.listPlanDriverValues(orgId, planId);
  const lines = await forecastLineService.listBuildLines(orgId, planId);
  const roleList = await headcountService.listRoles(orgId, planId);

  const roles: BuildRole[] = roleList.map((r) => ({
    roleId: r.id,
    title: r.title,
    accountId: r.accountId,
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    fteCount: r.fteCount,
    annualSalaryCents: r.annualSalaryCents,
    loadingBps: r.loadingBps,
  }));

  const build = buildForecast({ months, driverValues, lines, roles });

  const accountsList = await accountService.listAccounts(orgId, { includeInactive: true });
  const accountsById = new Map(accountsList.map((a) => [a.id, a]));
  const accounts = build.accountIds.map((accountId) => {
    const account = accountsById.get(accountId);
    return {
      accountId,
      code: account?.code ?? '',
      name: account?.name ?? '(unknown account)',
      type: account?.type ?? 'Expense',
    };
  });

  return {
    planId: plan.id,
    planName: plan.name,
    baseCurrency: org.baseCurrency,
    startsOn: plan.startsOn,
    horizonMonths: plan.horizonMonths,
    actualsThrough: plan.actualsThrough,
    accounts,
    build,
  };
}
