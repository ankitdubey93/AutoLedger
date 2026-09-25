import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, loginAgent, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — the bank-rules half
 * of bankConstraints.test.ts. Every test here goes around bankRuleService,
 * straight at the pool, proving migration 074's constraints and the updated
 * reject_bank_transaction_mutation() trigger hold regardless of what wrote
 * the row.
 */

const app = createApp();
const BANK_IMPORTS = '/api/v1/bank-imports';
const BANK_TRANSACTIONS = '/api/v1/bank-transactions';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const FEATURE_NOT_SUPPORTED = '0A000';

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return typeof err.code === 'string' ? err.code : undefined;
    }
  }
  return undefined;
}

let user: SeededUser;
let orgId: string;
type Agent = Awaited<ReturnType<typeof loginAgent>>;
let agent: Agent;

async function accountId(org: string, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = $1 AND code = $2',
    [org, code],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture: no account ${code}`);
  return row.id;
}

/** A committed, balanced two-line journal entry — unrelated to the triggers under test. */
async function insertBalancedEntry(
  org: string,
  createdBy: string,
  debitCode: string,
  creditCode: string,
  amountCents: number,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
       VALUES ($1, $2, '2026-07-01', 'raw sql fixture') RETURNING id`,
      [org, createdBy],
    );
    const entryId = rows[0]?.id;
    if (entryId === undefined) throw new Error('no entry id');

    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, $4, 0, 'USD', 1, $4, 0)`,
      [org, entryId, await accountId(org, debitCode), amountCents],
    );
    await client.query(
      `INSERT INTO ledger_lines (org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
       VALUES ($1, $2, $3, 0, $4, 'USD', 1, 0, $4)`,
      [org, entryId, await accountId(org, creditCode), amountCents],
    );

    await client.query('COMMIT');
    return entryId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertRule(
  org: string,
  createdBy: string,
  targetAccountIdValue: string,
  overrides: { amountMinCents?: number; amountMaxCents?: number } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bank_rules (org_id, name, memo_contains, amount_min_cents, amount_max_cents, target_account_id, created_by)
     VALUES ($1, 'Raw SQL rule', 'FEE', $2, $3, $4, $5)
     RETURNING id`,
    [org, overrides.amountMinCents ?? null, overrides.amountMaxCents ?? null, targetAccountIdValue, createdBy],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no rule id');
  return row.id;
}

async function importSingleLine(
  accId: string,
  date: string,
  description: string,
  amountCents: number,
): Promise<string> {
  const amountText = (amountCents / 100).toFixed(2);
  const res = await agent.post(BANK_IMPORTS).send({
    accountId: accId,
    fileName: 'single.csv',
    content: `Date,Description,Amount\n${date},${description},${amountText}`,
    dateFormat: 'ISO',
  });
  if (res.status !== 201) throw new Error(`fixture: import failed ${res.status} ${JSON.stringify(res.body)}`);
  const listRes = await agent.get(`${BANK_TRANSACTIONS}?accountId=${accId}&status=UNMATCHED&limit=100`);
  const transactions = listRes.body.transactions as Array<{ id: string; description: string }>;
  const txn = transactions.find((t) => t.description === description);
  if (txn === undefined) throw new Error('fixture: imported transaction not found');
  return txn.id;
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'bankruleraw', orgName: 'Bank Rule Raw SQL Org' });
  orgId = user.orgId;
  agent = await loginAgent(app, user);
});

afterAll(closePool);

describe('bank_rules CHECK constraints', () => {
  it('min greater than max violates chk_bank_rules_amount_range', async () => {
    const feeAccountId = await accountId(orgId, '6600');
    const code = await errorCode(() =>
      insertRule(orgId, user.id, feeAccountId, { amountMinCents: 1000, amountMaxCents: 500 }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});

describe('bank_transactions rule constraints', () => {
  it('a bank_transactions row with matched_rule_id but no journal entry violates chk_bank_txn_rule_needs_journal', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const feeAccountId = await accountId(orgId, '6600');
    // Imported before the rule exists, so nothing auto-settles it — the
    // point of this test is the raw-SQL UPDATE below, not the service path.
    const txnId = await importSingleLine(cashAccountId, '2026-06-01', 'Fee', -1000);
    const ruleId = await insertRule(orgId, user.id, feeAccountId);

    const code = await errorCode(() =>
      pool.query('UPDATE bank_transactions SET matched_rule_id = $1 WHERE id = $2', [ruleId, txnId]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('the immutability trigger allows changing matched_rule_id', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const feeAccountId = await accountId(orgId, '6600');
    const journalEntryId = await insertBalancedEntry(orgId, user.id, '6600', '1110', 4000);
    // Imported before the rule exists, so nothing auto-settles it.
    const txnId = await importSingleLine(cashAccountId, '2026-06-01', 'Fee', -4000);
    const ruleId = await insertRule(orgId, user.id, feeAccountId);

    await pool.query(
      `UPDATE bank_transactions
          SET status = 'MATCHED', matched_journal_entry_id = $1, matched_rule_id = $2,
              matched_at = now(), matched_by = $3
        WHERE id = $4`,
      [journalEntryId, ruleId, user.id, txnId],
    );

    const { rows } = await pool.query<{ status: string; matched_rule_id: string | null }>(
      'SELECT status, matched_rule_id FROM bank_transactions WHERE id = $1',
      [txnId],
    );
    expect(rows[0]?.status).toBe('MATCHED');
    expect(rows[0]?.matched_rule_id).toBe(ruleId);
  });

  it('the immutability trigger still rejects changing the description', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const txnId = await importSingleLine(cashAccountId, '2026-06-01', 'Fee', -1000);

    const code = await errorCode(() =>
      pool.query(`UPDATE bank_transactions SET description = 'Changed' WHERE id = $1`, [txnId]),
    );
    expect(code).toBe(FEATURE_NOT_SUPPORTED);
  });

  it('fk_bank_txn_rule rejects another org rule id', async () => {
    const cashAccountId = await accountId(orgId, '1110');
    const journalEntryId = await insertBalancedEntry(orgId, user.id, '6600', '1110', 4000);
    const txnId = await importSingleLine(cashAccountId, '2026-06-01', 'Fee', -4000);

    const otherOrg = await createUserWithOrg({ label: 'bankruleraw2', orgName: 'Bank Rule Raw SQL Org 2' });
    const otherFeeAccountId = await accountId(otherOrg.orgId, '6600');
    const foreignRuleId = await insertRule(otherOrg.orgId, otherOrg.id, otherFeeAccountId);

    const code = await errorCode(() =>
      pool.query(
        `UPDATE bank_transactions
            SET status = 'MATCHED', matched_journal_entry_id = $1, matched_rule_id = $2,
                matched_at = now(), matched_by = $3
          WHERE id = $4`,
        [journalEntryId, foreignRuleId, user.id, txnId],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});
