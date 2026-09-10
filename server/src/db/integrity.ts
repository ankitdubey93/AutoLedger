import { pool } from './connect.js';
import { parseCents } from '../utils/money.js';

/**
 * Phase 5's standalone integrity checker — the script an auditor is shown.
 * See docs/roadmap.md's "Audit trail & CDC (Phase 5)" entry and
 * docs/ledger-core.md's "Audit trail & internal controls" section.
 *
 * Every query below is **deliberately not scoped by `org_id`** — the single
 * sanctioned exception to guardrails rule 1 in this codebase. The point of
 * this checker is to prove an invariant across the *whole* database, which a
 * per-tenant query cannot do. It lives here, in `src/db/`, rather than in
 * `src/services/`, precisely so no request-serving service can import an
 * unscoped query by accident — nothing under `src/services/` or
 * `src/controllers/` may import from this file. Every offender this file
 * reports still carries its own `org_id`, so a failure remains traceable to
 * one tenant even though the query that found it was not scoped to one.
 *
 * This module only computes the report; `scripts/verifyIntegrity.ts` is
 * where the process actually exits, so importing this file (e.g. from a
 * test) never terminates the test runner.
 */

export interface IntegrityCheck {
  name: 'debits_equal_credits' | 'every_entry_balances' | 'no_orphaned_ledger_lines';
  description: string;
  passed: boolean;
  /** Up to 20 offending rows, for the operator to go look at. Empty when passed. */
  offenders: { orgId: string | null; subject: string; detail: string }[];
}

export interface IntegrityReport {
  checkedAt: string;
  passed: boolean;
  checks: IntegrityCheck[];
}

/**
 * Total debits must equal total credits across every `ledger_lines` row in
 * the database. Integer `BigInt` comparison, never a float or an epsilon
 * (guardrails rule 3) — the two totals are either exactly equal or they are
 * not.
 *
 * Base currency, not native (Phase 8): the reporting currency is each
 * organization's base currency, and a line's native amount may be in any
 * currency — summing native amounts across currencies is meaningless. Base
 * currency is what balances; see migration 023 and
 * study/postgresql/multi-currency-and-functional-currency.md.
 */
async function checkDebitsEqualCredits(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{ total_debits: string; total_credits: string }>(
    `SELECT COALESCE(SUM(base_debit_cents), 0)::text AS total_debits,
            COALESCE(SUM(base_credit_cents), 0)::text AS total_credits
       FROM ledger_lines`,
  );
  const row = rows[0];
  const totalDebits = row === undefined ? 0n : BigInt(parseCents(row.total_debits));
  const totalCredits = row === undefined ? 0n : BigInt(parseCents(row.total_credits));
  const passed = totalDebits === totalCredits;

  return {
    name: 'debits_equal_credits',
    description: 'Total base-currency debits must equal total base-currency credits across the entire ledger.',
    passed,
    offenders: passed
      ? []
      : [
          {
            orgId: null,
            subject: 'ledger_lines',
            detail: `total debits ${totalDebits.toString()} != total credits ${totalCredits.toString()} (difference ${(totalDebits - totalCredits).toString()})`,
          },
        ],
  };
}

/**
 * Every individual journal entry must balance on its own — the same
 * invariant migration 004/023's deferred constraint trigger enforces at
 * `COMMIT` time, re-verified here from scratch against whatever is actually
 * in the table.
 *
 * Base currency, not native (Phase 8) — see checkDebitsEqualCredits above.
 * An entry mixing currencies (a realized-FX settlement) legitimately fails
 * a native-sum check while still balancing in base currency, which is the
 * only sum this check is entitled to assert on.
 */
async function checkEveryEntryBalances(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{
    org_id: string;
    journal_entry_id: string;
    total_debits: string;
    total_credits: string;
  }>(
    `SELECT e.org_id, l.journal_entry_id,
            SUM(l.base_debit_cents)::text AS total_debits,
            SUM(l.base_credit_cents)::text AS total_credits
       FROM ledger_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id
      GROUP BY e.org_id, l.journal_entry_id
     HAVING SUM(l.base_debit_cents) <> SUM(l.base_credit_cents)
      LIMIT 20`,
  );

  return {
    name: 'every_entry_balances',
    description: 'Every journal entry must have equal base-currency debits and credits across its own lines.',
    passed: rows.length === 0,
    offenders: rows.map((r) => ({
      orgId: r.org_id,
      subject: `journal_entries/${r.journal_entry_id}`,
      detail: `debits ${r.total_debits} != credits ${r.total_credits}`,
    })),
  };
}

/**
 * No ledger line may be orphaned: either its parent entry does not exist, or
 * (a worse form of the same problem) its parent exists in a *different*
 * organization than the line itself claims. One query covers both, since a
 * tenant mismatch is a tenant leak and deserves at least as much attention
 * as a missing parent.
 */
async function checkNoOrphanedLedgerLines(): Promise<IntegrityCheck> {
  const { rows } = await pool.query<{
    id: string;
    org_id: string;
    journal_entry_id: string;
    missing_parent: boolean;
    tenant_mismatch: boolean;
  }>(
    `SELECT l.id, l.org_id, l.journal_entry_id,
            (e.id IS NULL) AS missing_parent,
            (e.id IS NOT NULL AND e.org_id <> l.org_id) AS tenant_mismatch
       FROM ledger_lines l
       LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE e.id IS NULL OR e.org_id <> l.org_id
      LIMIT 20`,
  );

  return {
    name: 'no_orphaned_ledger_lines',
    description: 'Every ledger line must belong to a journal entry in the same organization.',
    passed: rows.length === 0,
    offenders: rows.map((r) => ({
      orgId: r.org_id,
      subject: `ledger_lines/${r.id}`,
      detail: r.missing_parent
        ? `journal_entry_id ${r.journal_entry_id} does not exist`
        : `journal_entry_id ${r.journal_entry_id} belongs to a different organization`,
    })),
  };
}

export async function runIntegrityChecks(): Promise<IntegrityReport> {
  const checks = await Promise.all([
    checkDebitsEqualCredits(),
    checkEveryEntryBalances(),
    checkNoOrphanedLedgerLines(),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    passed: checks.every((c) => c.passed),
    checks,
  };
}
