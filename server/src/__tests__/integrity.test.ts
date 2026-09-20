import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../db/connect.js';
import { runIntegrityChecks } from '../db/integrity.js';
import * as journalService from '../services/ledger-core/journalService.js';
import { createUserWithOrg, resetTables } from './helpers/factories.js';
import type { SeededUser } from './helpers/factories.js';

/**
 * Phase 5's `verify:integrity` checker, exercised directly (not through the
 * CLI script — see `scripts/verifyIntegrity.ts` for why the two are split).
 *
 * Cases 3–5 manufacture the exact rows the schema's own triggers or
 * constraints exist to prevent, via `ALTER TABLE ... DISABLE TRIGGER USER`
 * (cases 3, 4) or `DISABLE TRIGGER ALL` (case 5, which needs to bypass a
 * foreign key — enforced by an internal trigger, not a user one). This is
 * the mandatory proof from docs/roadmap.md that the checker "must be able
 * to fail" — a suite where it only ever passes has not actually tested it.
 * Every DISABLE is re-enabled in a `finally`, because a test that leaves
 * one off would poison every later test in the file.
 */

let userA: SeededUser;
let userB: SeededUser;
let orgA: string;
let orgB: string;

async function accountId(orgId: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [orgId, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code} in org ${orgId}`);
  return row.id;
}

beforeEach(async () => {
  await resetTables();
  userA = await createUserWithOrg({ label: 'alice', orgName: 'Org Alpha' });
  userB = await createUserWithOrg({ label: 'bob', orgName: 'Org Bravo' });
  orgA = userA.orgId;
  orgB = userB.orgId;
});

afterEach(async () => {
  // Belt and braces: every DISABLE in this file has its own try/finally
  // ENABLE, but a test that throws before reaching it must not leave the
  // trigger off for the next test file in the run.
  await pool.query('ALTER TABLE journal_entries ENABLE TRIGGER USER');
  await pool.query('ALTER TABLE ledger_lines ENABLE TRIGGER USER');
  await pool.query('ALTER TABLE bank_transactions ENABLE TRIGGER ALL');
});

afterAll(closePool);

describe('verify:integrity', () => {
  it('passes on an empty database', async () => {
    const report = await runIntegrityChecks();

    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(4);
    for (const check of report.checks) {
      expect(check.passed).toBe(true);
      expect(check.offenders).toEqual([]);
    }
  });

  it('passes after a balanced entry', async () => {
    await journalService.createEntry(orgA, userA.id, {
      entryDate: '2026-08-15',
      description: 'Balanced',
      lines: [
        { accountId: await accountId(orgA, '6120'), debitCents: 10000, creditCents: 0 },
        { accountId: await accountId(orgA, '2100'), debitCents: 0, creditCents: 10000 },
      ],
    });

    const report = await runIntegrityChecks();
    expect(report.passed).toBe(true);
  });

  it('fails when an entry does not balance', async () => {
    await pool.query('ALTER TABLE ledger_lines DISABLE TRIGGER USER');
    await pool.query('ALTER TABLE journal_entries DISABLE TRIGGER USER');
    try {
      const { rows: entryRows } = await pool.query<{ id: string }>(
        `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
         VALUES ($1, $2, '2026-08-15', 'deliberately broken') RETURNING id`,
        [orgA, userA.id],
      );
      const entryId = entryRows[0]?.id;
      if (entryId === undefined) throw new Error('fixture: no entry id');

      await pool.query(
        `INSERT INTO ledger_lines
           (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
            currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, 10000, 0, 'USD', 1, 10000, 0)`,
        [orgA, entryId, await accountId(orgA, '6120')],
      );
      await pool.query(
        `INSERT INTO ledger_lines
           (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
            currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, 0, 9900, 'USD', 1, 0, 9900)`,
        [orgA, entryId, await accountId(orgA, '2100')],
      );

      const report = await runIntegrityChecks();

      expect(report.passed).toBe(false);
      const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
      expect(byName.debits_equal_credits?.passed).toBe(false);
      expect(byName.every_entry_balances?.passed).toBe(false);
      expect(byName.every_entry_balances?.offenders[0]?.orgId).toBe(orgA);
    } finally {
      await pool.query('ALTER TABLE journal_entries ENABLE TRIGGER USER');
      await pool.query('ALTER TABLE ledger_lines ENABLE TRIGGER USER');
    }
  });

  it("fails when a ledger line's org_id disagrees with its entry", async () => {
    await pool.query('ALTER TABLE ledger_lines DISABLE TRIGGER USER');
    await pool.query('ALTER TABLE journal_entries DISABLE TRIGGER USER');
    try {
      const { rows: entryRows } = await pool.query<{ id: string }>(
        `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
         VALUES ($1, $2, '2026-08-15', 'deliberately cross-tenant') RETURNING id`,
        [orgA, userA.id],
      );
      const entryId = entryRows[0]?.id;
      if (entryId === undefined) throw new Error('fixture: no entry id');

      // A line claiming org B, on an entry that actually belongs to org A.
      await pool.query(
        `INSERT INTO ledger_lines
           (org_id, journal_entry_id, account_id, debit_cents, credit_cents,
            currency_code, fx_rate, base_debit_cents, base_credit_cents)
         VALUES ($1, $2, $3, 10000, 0, 'USD', 1, 10000, 0)`,
        [orgB, entryId, await accountId(orgB, '6120')],
      );

      const report = await runIntegrityChecks();

      expect(report.passed).toBe(false);
      const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
      expect(byName.no_orphaned_ledger_lines?.passed).toBe(false);
      expect(byName.no_orphaned_ledger_lines?.offenders[0]?.orgId).toBe(orgB);
    } finally {
      await pool.query('ALTER TABLE journal_entries ENABLE TRIGGER USER');
      await pool.query('ALTER TABLE ledger_lines ENABLE TRIGGER USER');
    }
  });

  it('fails when a bank line names a journal entry that does not exist (Phase 6.1)', async () => {
    // fk_bank_txn_journal_entry (057) is what this check re-verifies from
    // scratch, so manufacturing the violation means bypassing that FK —
    // ALTER TABLE ... DISABLE TRIGGER ALL, not USER: a foreign key is
    // enforced by an internal trigger, which DISABLE TRIGGER USER does not
    // touch.
    await pool.query('ALTER TABLE bank_transactions DISABLE TRIGGER ALL');
    try {
      const cashAccountId = await accountId(orgA, '1110');
      const { rows: importRows } = await pool.query<{ id: string }>(
        `INSERT INTO bank_statement_imports (org_id, account_id, file_name, date_format, delimiter, created_by)
         VALUES ($1, $2, 'raw.csv', 'ISO', ',', $3) RETURNING id`,
        [orgA, cashAccountId, userA.id],
      );
      const importId = importRows[0]?.id;
      if (importId === undefined) throw new Error('fixture: no import id');

      const bogusEntryId = '00000000-0000-0000-0000-000000000000';
      const { rows: txnRows } = await pool.query<{ id: string }>(
        `INSERT INTO bank_transactions
           (org_id, import_id, account_id, txn_date, description, currency_code, amount_cents,
            dedupe_hash, status, matched_journal_entry_id, matched_at, matched_by)
         VALUES ($1, $2, $3, '2026-08-15', 'Orphaned journal ref', 'USD', -1000,
                 'deadbeef00000000000000000000000000000000000000000000000000ff', 'MATCHED', $4, now(), $5)
         RETURNING id`,
        [orgA, importId, cashAccountId, bogusEntryId, userA.id],
      );
      const txnId = txnRows[0]?.id;
      if (txnId === undefined) throw new Error('fixture: no bank transaction id');

      const report = await runIntegrityChecks();

      expect(report.passed).toBe(false);
      const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
      expect(byName.bank_line_journal_entries_exist?.passed).toBe(false);
      expect(byName.bank_line_journal_entries_exist?.offenders[0]?.orgId).toBe(orgA);
      expect(byName.bank_line_journal_entries_exist?.offenders[0]?.subject).toBe(`bank_transactions/${txnId}`);
    } finally {
      await pool.query('ALTER TABLE bank_transactions ENABLE TRIGGER ALL');
    }
  });
});
