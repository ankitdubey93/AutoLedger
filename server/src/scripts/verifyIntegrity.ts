import { pool } from '../db/connect.js';
import { runIntegrityChecks } from '../db/integrity.js';

/**
 * `npm run verify:integrity` — the script you run in front of an auditor.
 *
 * Deliberately split from `db/integrity.ts`: that module only computes a
 * report, so importing it (e.g. from a test) is side-effect free. This file
 * is the CLI tail — it runs on import, prints, and exits the process — which
 * is exactly what must NOT happen if `runIntegrityChecks` is imported from
 * inside the test runner.
 */
try {
  const report = await runIntegrityChecks();

  for (const check of report.checks) {
    console.log(`[${check.passed ? 'PASS' : 'FAIL'}] ${check.name} — ${check.description}`);
    for (const offender of check.offenders) {
      console.log(`    org ${offender.orgId ?? '(unscoped)'}: ${offender.subject} — ${offender.detail}`);
    }
  }

  console.log(report.passed ? '\nIntegrity check passed.' : '\nIntegrity check FAILED.');

  await pool.end();
  process.exit(report.passed ? 0 : 1);
} catch (err) {
  console.error('[verify:integrity] failed to run:', err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
}
