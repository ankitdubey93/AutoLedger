/**
 * The sandbox dataset — Phase 18.
 *
 * Platform-layer, unprefixed, mirroring `types/onboarding.ts` and
 * `types/documents.ts`: the dataset spans every app, and the orchestrator that
 * loads it owns no app's tables (guardrails rule 16).
 *
 * There is no status FSM here. A dataset is either loaded for an organization
 * or it is not, and that is one row's existence — not a lifecycle. Nothing
 * transitions, so nothing needs a transition table.
 */

/**
 * What a load produced, per app. Display data for the "sample data is loaded"
 * card; nothing branches on it. Every per-app seeder returns a
 * `Partial<SandboxCounts>` and the orchestrator merges them.
 */
export interface SandboxCounts {
  customers: number;
  vendors: number;
  invoices: number;
  bills: number;
  payments: number;
  bankLines: number;
  apFlowDocuments: number;
  forecastPlans: number;
  fpaModels: number;
  productLines: number;
  closeRuns: number;
  corpusDocuments: number;
}

export const EMPTY_SANDBOX_COUNTS: SandboxCounts = {
  customers: 0,
  vendors: 0,
  invoices: 0,
  bills: 0,
  payments: 0,
  bankLines: 0,
  apFlowDocuments: 0,
  forecastPlans: 0,
  fpaModels: 0,
  productLines: 0,
  closeRuns: 0,
  corpusDocuments: 0,
};

export interface SandboxDataset {
  orgId: string;
  datasetVersion: string;
  /** 'YYYY-MM-01' — the month every fixture `monthOffset` was resolved against. */
  anchorMonth: string;
  counts: SandboxCounts;
  loadedAt: string;
}

export interface SandboxStatus {
  loaded: boolean;
  dataset: SandboxDataset | null;
}

/**
 * Passed to every per-app `seedSandbox`. Carries the tenant, the actor, and the
 * date resolver — never a database client: each app's own services open their
 * own transactions, and handing one down would mean a service running off a
 * client it did not check out (guardrails rule 5).
 */
export interface SandboxSeedContext {
  orgId: string;
  /** The OWNER performing the load; becomes `created_by` on every seeded row. */
  userId: string;
  /** 'YYYY-MM-01' for offset 0. */
  anchorMonth: string;
  /**
   * Resolves a fixture's relative `monthOffset` (-23..0) and `day` (1..28)
   * to a real 'YYYY-MM-DD'. Fixtures carry no absolute dates — an absolute
   * date rots, drifting out of the cohort window and the fiscal year within
   * months of being written.
   */
  monthDate(offset: number, day: number): string;
}
