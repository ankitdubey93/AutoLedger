import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { loadManifest, resolveMonth, currentAnchorMonth } from './sandboxManifest.js';
import * as ledgerCoreSeed from '../ledger-core/sandboxSeed.js';
import * as apFlowSeed from '../ap-flow/sandboxSeed.js';
import * as forecasterSeed from '../forecaster/sandboxSeed.js';
import * as fpaEngineSeed from '../fpa-engine/sandboxSeed.js';
import * as uniteconSeed from '../unitecon/sandboxSeed.js';
import * as boarddeckSeed from '../boarddeck/sandboxSeed.js';
import * as taxguardSeed from '../taxguard/sandboxSeed.js';
import { EMPTY_SANDBOX_COUNTS } from '../../types/sandbox.js';
import type { SandboxCounts, SandboxDataset, SandboxSeedContext, SandboxStatus } from '../../types/sandbox.js';

const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface DatasetRow {
  org_id: string;
  dataset_version: string;
  anchor_month: string;
  counts: SandboxCounts;
  loaded_at: Date;
}

function toDataset(row: DatasetRow): SandboxDataset {
  return {
    orgId: row.org_id,
    datasetVersion: row.dataset_version,
    anchorMonth: row.anchor_month,
    counts: row.counts,
    loadedAt: row.loaded_at.toISOString(),
  };
}

/**
 * Phase 18 — the sandbox orchestrator.
 *
 * This is the ONLY file that owns `sandbox_datasets`, the platform table it
 * writes to directly. Every business record the dataset produces — every
 * customer, invoice, driver, model, corpus document — is created by calling
 * one of the seven imported `seedSandbox` functions, each living in its own
 * app's own service folder and touching only that app's own tables
 * (guardrails rule 16). This file contains no SQL against any app table.
 *
 * Seeding is MANY transactions, not one: each `seedSandbox` function calls
 * ordinary app services, and each of those services owns its own
 * `BEGIN…COMMIT`. Wrapping the whole load in a single transaction here would
 * mean those services running off a client this file checked out instead of
 * their own — exactly what guardrails rule 5 forbids. A crash partway
 * through a load therefore leaves a partially-seeded organization rather
 * than rolling back cleanly; that is an accepted, recorded trade for reusing
 * the real service layer rather than writing a second, SQL-only seeding
 * path that would drift from it. The fix for a bad partial load is the same
 * fix for any bad data in this suite: fix it by hand, or delete the
 * organization and start over — there is no partial-seed repair tool.
 */

export async function getSandboxStatus(orgId: string): Promise<SandboxStatus> {
  const { rows } = await pool.query<DatasetRow>(
    'SELECT org_id, dataset_version, anchor_month::text AS anchor_month, counts, loaded_at FROM sandbox_datasets WHERE org_id = $1',
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) return { loaded: false, dataset: null };
  return { loaded: true, dataset: toDataset(row) };
}

export async function loadSandbox(orgId: string, userId: string): Promise<SandboxDataset> {
  const manifest = await loadManifest();
  const anchorMonth = currentAnchorMonth();

  // Claim the slot FIRST, before any seeding runs. UNIQUE (org_id) is what
  // makes a concurrent or repeated load impossible rather than merely
  // discouraged — a service-level "check then seed" would leave a race
  // between the check and the first INSERT the seeders below perform.
  await withTransaction(async (client) => {
    try {
      await client.query(
        `INSERT INTO sandbox_datasets (org_id, dataset_version, anchor_month, counts, loaded_by)
         VALUES ($1, $2, $3::date, $4::jsonb, $5)`,
        [orgId, manifest.datasetVersion, anchorMonth, JSON.stringify(EMPTY_SANDBOX_COUNTS), userId],
      );
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new ApiError(409, 'Sample data is already loaded for this organization');
      }
      throw err;
    }
  });

  const ctx: SandboxSeedContext = {
    orgId,
    userId,
    anchorMonth,
    monthDate: (offset, day) => resolveMonth(anchorMonth, offset, day),
  };

  // Order matches the dependency chain: LedgerCore first (every other
  // seeder needs its account ids), then the four apps that read LedgerCore
  // actuals, then AP-Flow and TaxGuard, which are independent of both.
  //
  // The claim above is committed in its own transaction, so a seeder
  // throwing here would otherwise leave the marker behind saying "loaded"
  // with all-zero counts — a marker that LIES, and one the client would
  // faithfully render as a loaded dataset of nothing. Releasing the claim
  // on failure is the only honest option: seeding deliberately is not one
  // transaction (rule 5), so the partial business data it wrote cannot be
  // rolled back, but the marker asserting a *successful* load can and must
  // be withdrawn. Whatever rows the failed attempt did write stay, and
  // `assertNotAlreadySeeded` in LedgerCore's own seeder is what stops a
  // retry from compounding them.
  let counts: SandboxCounts;
  try {
    const ledgerCoreResult = await ledgerCoreSeed.seedSandbox(ctx, manifest.baseCurrency);
    const apFlowCounts = await apFlowSeed.seedSandbox(ctx, ledgerCoreResult.accountsByCode);
    const forecasterCounts = await forecasterSeed.seedSandbox(ctx, ledgerCoreResult.accountsByCode);
    const fpaEngineCounts = await fpaEngineSeed.seedSandbox(ctx, ledgerCoreResult.accountsByCode);
    const uniteconCounts = await uniteconSeed.seedSandbox(ctx, ledgerCoreResult.accountsByCode);
    const boarddeckCounts = await boarddeckSeed.seedSandbox(ctx);
    const taxguardCounts = await taxguardSeed.seedSandbox(ctx);

    counts = {
      ...EMPTY_SANDBOX_COUNTS,
      ...ledgerCoreResult.counts,
      ...apFlowCounts,
      ...forecasterCounts,
      ...fpaEngineCounts,
      ...uniteconCounts,
      ...boarddeckCounts,
      ...taxguardCounts,
    };
  } catch (err) {
    await pool.query('DELETE FROM sandbox_datasets WHERE org_id = $1', [orgId]);
    throw err;
  }

  await pool.query('UPDATE sandbox_datasets SET counts = $2::jsonb WHERE org_id = $1', [
    orgId,
    JSON.stringify(counts),
  ]);

  const status = await getSandboxStatus(orgId);
  if (status.dataset === null) throw new Error('loadSandbox: dataset row vanished after its own load');
  return status.dataset;
}

/**
 * Removes the load marker only. Posted financial documents are immutable by
 * trigger and stay that way (guardrails rule 6) — this deliberately does
 * NOT unpick the seeded ledger. Removing seeded financial records means
 * deleting the organization; that is stated to the caller in the API
 * response, never silently.
 */
export async function unloadSandbox(orgId: string): Promise<void> {
  const { rowCount } = await pool.query('DELETE FROM sandbox_datasets WHERE org_id = $1', [orgId]);
  if (rowCount === 0) {
    throw new ApiError(409, 'No sample data is loaded for this organization');
  }
}
