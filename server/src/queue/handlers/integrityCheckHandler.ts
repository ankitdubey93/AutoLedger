import { runIntegrityChecks } from '../../db/integrity.js';

/**
 * Pays the debt docs/roadmap.md records against Phase 5: "No
 * scheduled/continuous integrity check — verify:integrity runs on demand
 * until Phase 7's background jobs exist."
 *
 * This handler is the ONE place outside src/scripts/ allowed to import
 * db/integrity.ts. That file's own header forbids src/services/ and
 * src/controllers/ from importing it, because its queries are deliberately
 * unscoped by org_id; a queue handler serves no request and leaks nothing
 * to a tenant, so the ban does not extend here. Do not relax it anywhere else.
 *
 * On failure it THROWS. With attempts: 1 (see worker.ts) that sends the job
 * straight to the dead-letter queue, which is Phase 7's alerting channel —
 * an unbalanced ledger is not a transient error and must not be retried
 * four more times into silence.
 */
export async function handleIntegrityCheck(): Promise<void> {
  const report = await runIntegrityChecks();

  if (report.passed) {
    console.log('[worker] integrity-check passed');
    return;
  }

  const failed = report.checks.filter((c) => !c.passed).map((c) => c.name).join(', ');
  throw new Error(`Ledger integrity check failed: ${failed}`);
}
