import * as modelService from './modelService.js';
import * as assumptionService from './assumptionService.js';
import { loadFixture } from '../sandbox/sandboxManifest.js';
import type { SandboxSeedContext, SandboxCounts } from '../../types/sandbox.js';
import { fpaModelFixtureSchema } from '../../schemas/sandboxSchema.js';

/**
 * Phase 18 — FP&A Engine's sandbox seeder.
 *
 * Imports ONLY `services/fpa-engine/`. Account ids arrive pre-resolved in
 * `accountsByCode` from the LedgerCore seeder (guardrails rule 16) — this
 * file never imports `services/ledger-core/accountService`.
 */
export async function seedSandbox(
  ctx: SandboxSeedContext,
  accountsByCode: Map<string, string>,
): Promise<Partial<SandboxCounts>> {
  const fixture = await loadFixture('fpa-engine/model.json', fpaModelFixtureSchema);

  function accountId(code: string): string {
    const id = accountsByCode.get(code);
    if (id === undefined) throw new Error(`sandboxSeed(fpa-engine): account ${code} not found`);
    return id;
  }

  const model = await modelService.createModel(ctx.orgId, ctx.userId, {
    name: fixture.model.name,
    description: fixture.model.description,
    startsOn: ctx.monthDate(fixture.model.startsOnMonthOffset, 1),
    horizonMonths: fixture.model.horizonMonths,
    actualsThrough: ctx.monthDate(fixture.model.actualsThroughMonthOffset, 1),
  });

  // createModel already inserted one default scenario named 'Base'. Update
  // that row in place for the fixture's default scenario, rather than
  // creating a second scenario with the same name and hitting
  // ux_fpa_scenarios_one_default's sibling unique-name constraint.
  const existingScenarios = await modelService.listScenarios(ctx.orgId, model.id);
  const scenarioIdsByKey = new Map<string, string>();

  for (const s of fixture.scenarios) {
    let scenarioId: string;
    if (s.isDefault) {
      const defaultScenario = existingScenarios.find((sc) => sc.isDefault);
      if (defaultScenario === undefined) {
        throw new Error('sandboxSeed(fpa-engine): createModel did not create a default scenario');
      }
      const updated = await modelService.updateScenario(ctx.orgId, defaultScenario.id, {
        name: s.name,
        dsoDays: s.dsoDays,
        dpoDays: s.dpoDays,
        taxRateBps: s.taxRateBps,
      });
      scenarioId = updated.id;
    } else {
      const created = await modelService.createScenario(ctx.orgId, model.id, {
        name: s.name,
        kind: 'DOWNSIDE',
        dsoDays: s.dsoDays,
        dpoDays: s.dpoDays,
        taxRateBps: s.taxRateBps,
      });
      scenarioId = created.id;
    }
    scenarioIdsByKey.set(s.key, scenarioId);

    for (const a of s.assumptions) {
      if (a.kind === 'GROWTH_BPS') {
        await assumptionService.upsertAssumption(ctx.orgId, scenarioId, accountId(a.accountCode), {
          kind: 'GROWTH_BPS',
          growthBps: a.growthBps,
        });
      } else if (a.kind === 'FIXED_CENTS') {
        await assumptionService.upsertAssumption(ctx.orgId, scenarioId, accountId(a.accountCode), {
          kind: 'FIXED_CENTS',
          fixedCents: a.fixedCents,
        });
      } else {
        await assumptionService.upsertAssumption(ctx.orgId, scenarioId, accountId(a.accountCode), {
          kind: 'PERCENT_OF_REVENUE_BPS',
          percentOfRevenueBps: a.percentOfRevenueBps,
        });
      }
    }
  }

  return { fpaModels: 1 };
}
