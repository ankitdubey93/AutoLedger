import * as planService from './planService.js';
import * as driverService from './driverService.js';
import * as headcountService from './headcountService.js';
import * as forecastLineService from './forecastLineService.js';
import * as budgetService from './budgetService.js';
import { loadFixture } from '../sandbox/sandboxManifest.js';
import type { SandboxSeedContext, SandboxCounts } from '../../types/sandbox.js';
import { forecasterPlanFixtureSchema } from '../../schemas/sandboxSchema.js';

/**
 * Phase 18 — ForecasterPro's sandbox seeder.
 *
 * Imports ONLY `services/forecaster/`. It does not import LedgerCore's
 * `accountService` directly — the account ids it needs arrive already
 * resolved, in `accountsByCode`, from the LedgerCore seeder that ran first
 * (guardrails rule 16: this file still reads no other app's tables, and the
 * map handed to it was built by that app's own service calls, not by SQL
 * here).
 */
export async function seedSandbox(
  ctx: SandboxSeedContext,
  accountsByCode: Map<string, string>,
): Promise<Partial<SandboxCounts>> {
  const fixture = await loadFixture('forecaster/plan.json', forecasterPlanFixtureSchema);

  function accountId(code: string): string {
    const id = accountsByCode.get(code);
    if (id === undefined) throw new Error(`sandboxSeed(forecaster): account ${code} not found`);
    return id;
  }

  const plan = await planService.createPlan(ctx.orgId, ctx.userId, {
    name: fixture.plan.name,
    description: fixture.plan.description,
    startsOn: ctx.monthDate(fixture.plan.startsOnMonthOffset, 1),
    horizonMonths: fixture.plan.horizonMonths,
    actualsThrough: ctx.monthDate(fixture.plan.actualsThroughMonthOffset, 1),
  });

  const driverIdsByKey = new Map<string, string>();
  for (const d of fixture.drivers) {
    const driver = await driverService.createDriver(ctx.orgId, plan.id, {
      name: d.name,
      unitLabel: d.unitLabel,
      kind: d.kind,
    });
    driverIdsByKey.set(d.key, driver.id);

    await driverService.setDriverValues(
      ctx.orgId,
      driver.id,
      d.monthly.map((m) => ({ month: ctx.monthDate(m.monthOffset, 1), value: m.value })),
    );
  }

  for (const role of fixture.headcount) {
    await headcountService.createRole(ctx.orgId, plan.id, {
      title: role.title,
      department: role.department,
      accountId: accountId(role.accountCode),
      startsOn: ctx.monthDate(role.startsOnMonthOffset, 1),
      endsOn: role.endsOnMonthOffset === null ? null : ctx.monthDate(role.endsOnMonthOffset, 1),
      fteCount: role.fteCount,
      annualSalaryCents: role.annualSalaryCents,
      loadingBps: role.loadingBps,
    });
  }

  for (const line of fixture.forecastLines) {
    if (line.kind === 'DRIVER_PRODUCT') {
      const quantityDriverId = driverIdsByKey.get(line.quantityDriverKey);
      const rateDriverId = driverIdsByKey.get(line.rateDriverKey);
      if (quantityDriverId === undefined || rateDriverId === undefined) {
        throw new Error(`sandboxSeed(forecaster): driver not found for line "${line.label}"`);
      }
      await forecastLineService.createLine(ctx.orgId, plan.id, {
        kind: 'DRIVER_PRODUCT',
        accountId: accountId(line.accountCode),
        label: line.label,
        quantityDriverId,
        rateDriverId,
      });
    } else if (line.kind === 'DRIVER_PERCENT') {
      const sourceDriverId = driverIdsByKey.get(line.sourceDriverKey);
      if (sourceDriverId === undefined) {
        throw new Error(`sandboxSeed(forecaster): driver not found for line "${line.label}"`);
      }
      await forecastLineService.createLine(ctx.orgId, plan.id, {
        kind: 'DRIVER_PERCENT',
        accountId: accountId(line.accountCode),
        label: line.label,
        sourceDriverId,
        percentBps: line.percentBps,
      });
    } else {
      await forecastLineService.createLine(ctx.orgId, plan.id, {
        kind: 'FIXED_CENTS',
        accountId: accountId(line.accountCode),
        label: line.label,
        fixedCents: line.fixedCents,
      });
    }
  }

  // --- the budget: manual lines first (compile leaves them alone), then
  // compile the driver/headcount build-up on top, then approve+freeze ---
  const version = await budgetService.createVersion(ctx.orgId, plan.id, ctx.userId, {
    label: fixture.budget.label,
  });

  for (const manual of fixture.budget.manualLines) {
    for (let i = 0; i < fixture.plan.horizonMonths; i++) {
      await budgetService.addLine(ctx.orgId, version.id, {
        accountId: accountId(manual.accountCode),
        month: ctx.monthDate(fixture.plan.startsOnMonthOffset + i, 1),
        amountCents: manual.amountCents,
        justification: manual.justification,
      });
    }
  }

  await budgetService.compileVersion(ctx.orgId, version.id);

  if (fixture.budget.approve) {
    await budgetService.approveVersion(ctx.orgId, version.id, ctx.userId);
  }

  return { forecastPlans: 1 };
}
