import * as settingsService from './settingsService.js';
import * as productLineService from './productLineService.js';
import { loadFixture } from '../sandbox/sandboxManifest.js';
import type { SandboxSeedContext, SandboxCounts } from '../../types/sandbox.js';
import { uniteconSettingsFixtureSchema } from '../../schemas/sandboxSchema.js';

/**
 * Phase 18 — UnitEcon's sandbox seeder.
 *
 * Imports ONLY `services/unitecon/`. Account ids arrive pre-resolved in
 * `accountsByCode` from the LedgerCore seeder (guardrails rule 16).
 */
export async function seedSandbox(
  ctx: SandboxSeedContext,
  accountsByCode: Map<string, string>,
): Promise<Partial<SandboxCounts>> {
  const fixture = await loadFixture('unitecon/settings.json', uniteconSettingsFixtureSchema);

  function accountId(code: string): string {
    const id = accountsByCode.get(code);
    if (id === undefined) throw new Error(`sandboxSeed(unitecon): account ${code} not found`);
    return id;
  }

  await settingsService.updateSettings(ctx.orgId, ctx.userId, {
    grossMarginBps: fixture.settings.grossMarginBps,
    acquisitionAccountIds: fixture.settings.acquisitionAccountCodes.map(accountId),
  });

  let productLineCount = 0;
  for (const p of fixture.productLines) {
    await productLineService.createProductLine(ctx.orgId, ctx.userId, {
      revenueAccountId: accountId(p.revenueAccountCode),
      name: p.name,
      unitLabel: p.unitLabel,
    });
    productLineCount += 1;
  }

  return { productLines: productLineCount };
}
