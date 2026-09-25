import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { AUTO_MATCH_THRESHOLD } from '../../utils/matchScore.js';
import { findMatchingRule, type BankRuleForMatch } from '../../utils/bankRuleMatch.js';
import * as journalService from './journalService.js';
import * as bankMatchService from './bankMatchService.js';
import type { BankRule, BankRuleDirection } from '../../types/accounting.js';

/**
 * Accounting bank rules (Phase 34a) — a saved pattern ("memo contains STRIPE
 * FEE, post to 6600 Bank Fees") that settles a matching bank line by posting
 * a journal entry through `bankMatchService.postJournalForTransactionOnClient`,
 * the same path a human uses from the transaction page. This file never
 * writes journal_entries or ledger_lines directly (guardrails rule 16).
 */

const PG_RAISE_EXCEPTION = 'P0001';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

// ---------------------------------------------------------------- row mapping

const BANK_RULE_SELECT = `SELECT b.id, b.name, b.priority, b.direction, b.memo_contains,
                                  b.amount_min_cents, b.amount_max_cents, b.bank_account_id,
                                  b.target_account_id, a.code AS target_account_code, a.name AS target_account_name,
                                  b.description, b.is_active, b.created_by, b.created_at, b.updated_at
                             FROM bank_rules b
                             JOIN accounts a ON a.id = b.target_account_id AND a.org_id = b.org_id`;

interface BankRuleRow {
  id: string;
  name: string;
  priority: number;
  direction: string;
  memo_contains: string;
  amount_min_cents: string | null;
  amount_max_cents: string | null;
  bank_account_id: string | null;
  target_account_id: string;
  target_account_code: string;
  target_account_name: string;
  description: string | null;
  is_active: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function toDirection(value: string, ruleId: string): BankRuleDirection {
  if (value !== 'IN' && value !== 'OUT' && value !== 'ANY') {
    throw new Error(`Unknown bank rule direction "${value}" on rule ${ruleId}`);
  }
  return value;
}

function toBankRule(row: BankRuleRow): BankRule {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    direction: toDirection(row.direction, row.id),
    memoContains: row.memo_contains,
    amountMinCents: row.amount_min_cents === null ? null : parseCents(row.amount_min_cents),
    amountMaxCents: row.amount_max_cents === null ? null : parseCents(row.amount_max_cents),
    bankAccountId: row.bank_account_id,
    targetAccountId: row.target_account_id,
    targetAccountCode: row.target_account_code,
    targetAccountName: row.target_account_name,
    description: row.description,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function getBankRuleById(orgId: string, id: string): Promise<BankRule> {
  const { rows } = await pool.query<BankRuleRow>(`${BANK_RULE_SELECT} WHERE b.id = $1 AND b.org_id = $2`, [
    id,
    orgId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Bank rule not found');
  return toBankRule(row);
}

// ---------------------------------------------------------------------- reads

export async function listBankRules(orgId: string, options: { includeInactive: boolean }): Promise<BankRule[]> {
  const clauses = ['b.org_id = $1'];
  if (!options.includeInactive) clauses.push('b.is_active');

  const { rows } = await pool.query<BankRuleRow>(
    `${BANK_RULE_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY b.priority, b.created_at`,
    [orgId],
  );
  return rows.map(toBankRule);
}

// --------------------------------------------------------------------- writes

export interface CreateBankRuleInput {
  name: string;
  priority: number;
  direction: BankRuleDirection;
  memoContains: string;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  bankAccountId: string | null;
  targetAccountId: string;
  description: string | null;
}

export interface UpdateBankRuleInput {
  name?: string | undefined;
  priority?: number | undefined;
  direction?: BankRuleDirection | undefined;
  memoContains?: string | undefined;
  amountMinCents?: (number | null) | undefined;
  amountMaxCents?: (number | null) | undefined;
  bankAccountId?: (string | null) | undefined;
  targetAccountId?: string | undefined;
  description?: (string | null) | undefined;
  isActive?: boolean | undefined;
}

interface MergedRuleValues {
  targetAccountId: string;
  bankAccountId: string | null;
  amountMinCents: number | null;
  amountMaxCents: number | null;
}

/**
 * Runs on the caller's transaction client, validated against the merged
 * (create or post-update) values — see Step 5's contract.
 */
async function validateRuleOnClient(client: PoolClient, orgId: string, values: MergedRuleValues): Promise<void> {
  const { rows } = await client.query<{ code: string; is_postable: boolean; is_active: boolean }>(
    'SELECT code, is_postable, is_active FROM accounts WHERE org_id = $1 AND id = $2',
    [orgId, values.targetAccountId],
  );
  const target = rows[0];
  if (target === undefined) throw new ApiError(422, 'Target account not found');
  if (!target.is_postable) {
    throw new ApiError(422, `Account ${target.code} is a header account and cannot be posted to`);
  }
  if (!target.is_active) {
    throw new ApiError(422, `Account ${target.code} is inactive`);
  }

  // Throws its own 422 (the SAP reconciliation-account rule, Phase 25).
  await journalService.assertNotControlAccountsOnClient(client, orgId, [values.targetAccountId]);

  if (values.bankAccountId !== null) {
    const { rows: bankRows } = await client.query<{ type: string }>(
      'SELECT type FROM accounts WHERE org_id = $1 AND id = $2',
      [orgId, values.bankAccountId],
    );
    const bankAccount = bankRows[0];
    if (bankAccount === undefined || bankAccount.type !== 'Asset') {
      throw new ApiError(422, 'Bank account not found');
    }
    if (values.bankAccountId === values.targetAccountId) {
      throw new ApiError(422, 'A rule cannot post back to its own bank account');
    }
  }

  if (
    values.amountMinCents !== null &&
    values.amountMaxCents !== null &&
    values.amountMinCents > values.amountMaxCents
  ) {
    throw new ApiError(422, 'amountMinCents must not exceed amountMaxCents');
  }
}

export async function createBankRule(
  orgId: string,
  createdBy: string,
  input: CreateBankRuleInput,
): Promise<BankRule> {
  const id = await withTransaction(async (client) => {
    await validateRuleOnClient(client, orgId, {
      targetAccountId: input.targetAccountId,
      bankAccountId: input.bankAccountId,
      amountMinCents: input.amountMinCents,
      amountMaxCents: input.amountMaxCents,
    });

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bank_rules
         (org_id, name, priority, direction, memo_contains, amount_min_cents, amount_max_cents,
          bank_account_id, target_account_id, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        orgId,
        input.name,
        input.priority,
        input.direction,
        input.memoContains,
        input.amountMinCents,
        input.amountMaxCents,
        input.bankAccountId,
        input.targetAccountId,
        input.description,
        createdBy,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return row.id;
  });
  return getBankRuleById(orgId, id);
}

export async function updateBankRule(orgId: string, id: string, input: UpdateBankRuleInput): Promise<BankRule> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    name: 'name',
    priority: 'priority',
    direction: 'direction',
    memoContains: 'memo_contains',
    amountMinCents: 'amount_min_cents',
    amountMaxCents: 'amount_max_cents',
    bankAccountId: 'bank_account_id',
    targetAccountId: 'target_account_id',
    description: 'description',
    isActive: 'is_active',
  } as const;

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<{
      target_account_id: string;
      bank_account_id: string | null;
      amount_min_cents: string | null;
      amount_max_cents: string | null;
    }>(
      `SELECT target_account_id, bank_account_id, amount_min_cents, amount_max_cents
         FROM bank_rules WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [id, orgId],
    );
    const existing = existingRows[0];
    if (existing === undefined) throw new ApiError(404, 'Bank rule not found');

    const merged: MergedRuleValues = {
      targetAccountId: input.targetAccountId ?? existing.target_account_id,
      bankAccountId: input.bankAccountId !== undefined ? input.bankAccountId : existing.bank_account_id,
      amountMinCents:
        input.amountMinCents !== undefined
          ? input.amountMinCents
          : existing.amount_min_cents === null
            ? null
            : parseCents(existing.amount_min_cents),
      amountMaxCents:
        input.amountMaxCents !== undefined
          ? input.amountMaxCents
          : existing.amount_max_cents === null
            ? null
            : parseCents(existing.amount_max_cents),
    };
    await validateRuleOnClient(client, orgId, merged);

    const assignments: string[] = [];
    const values: unknown[] = [id, orgId];

    for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
      const value = input[key];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
    }

    if (assignments.length > 0) {
      await client.query(`UPDATE bank_rules SET ${assignments.join(', ')} WHERE id = $1 AND org_id = $2`, values);
    }

    const { rows } = await client.query<BankRuleRow>(`${BANK_RULE_SELECT} WHERE b.id = $1 AND b.org_id = $2`, [
      id,
      orgId,
    ]);
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Bank rule not found');
    return toBankRule(row);
  });
}

// ------------------------------------------------------------------- applying

interface RuleForMatching extends BankRuleForMatch {
  targetAccountId: string;
  description: string | null;
}

interface CandidateLineRow {
  id: string;
  description: string;
  amount_cents: string;
  account_id: string;
}

/**
 * Applies active rules to the given lines on the caller's transaction.
 * Returns the ids it settled. A document suggestion scoring at or above
 * AUTO_MATCH_THRESHOLD always wins over a rule — those lines are excluded
 * from the candidate query entirely.
 */
export async function applyRulesOnClient(
  client: PoolClient,
  orgId: string,
  userId: string,
  transactionIds: readonly string[],
): Promise<string[]> {
  if (transactionIds.length === 0) return [];

  const { rows: ruleRows } = await client.query<{
    id: string;
    priority: number;
    created_at: Date;
    direction: string;
    memo_contains: string;
    amount_min_cents: string | null;
    amount_max_cents: string | null;
    bank_account_id: string | null;
    target_account_id: string;
    description: string | null;
  }>(
    `SELECT id, priority, created_at, direction, memo_contains, amount_min_cents, amount_max_cents,
            bank_account_id, target_account_id, description
       FROM bank_rules WHERE org_id = $1 AND is_active`,
    [orgId],
  );

  if (ruleRows.length === 0) return [];

  const rules: RuleForMatching[] = ruleRows.map((r) => ({
    id: r.id,
    priority: r.priority,
    createdAt: r.created_at.toISOString(),
    direction: toDirection(r.direction, r.id),
    memoContains: r.memo_contains,
    amountMinCents: r.amount_min_cents === null ? null : parseCents(r.amount_min_cents),
    amountMaxCents: r.amount_max_cents === null ? null : parseCents(r.amount_max_cents),
    bankAccountId: r.bank_account_id,
    targetAccountId: r.target_account_id,
    description: r.description,
  }));

  const { rows: lineRows } = await client.query<CandidateLineRow>(
    `SELECT t.id, t.description, t.amount_cents, t.account_id FROM bank_transactions t
      WHERE t.org_id = $1 AND t.id = ANY($2::uuid[]) AND t.status = 'UNMATCHED'
        AND NOT EXISTS (SELECT 1 FROM bank_match_suggestions s
                         WHERE s.org_id = $1 AND s.bank_transaction_id = t.id AND s.score >= $3)
      ORDER BY t.txn_date, t.id`,
    [orgId, transactionIds, AUTO_MATCH_THRESHOLD],
  );

  const settledIds: string[] = [];

  for (const line of lineRows) {
    const matched = findMatchingRule(
      {
        description: line.description,
        amountCents: parseCents(line.amount_cents),
        accountId: line.account_id,
      },
      rules,
    );
    if (matched === null) continue;

    await client.query('SAVEPOINT bank_rule_apply');
    try {
      await bankMatchService.postJournalForTransactionOnClient(
        client,
        orgId,
        userId,
        line.id,
        { accountId: matched.targetAccountId, description: matched.description },
        matched.id,
      );
      await client.query('RELEASE SAVEPOINT bank_rule_apply');
      settledIds.push(line.id);
    } catch (err) {
      if (err instanceof ApiError || pgErrorCode(err) === PG_RAISE_EXCEPTION) {
        await client.query('ROLLBACK TO SAVEPOINT bank_rule_apply');
        continue;
      }
      throw err;
    }
  }

  return settledIds;
}

/** POST /bank-rules/apply — every UNMATCHED line in the org, oldest first, at most 1000, one transaction. */
export async function applyRulesToUnmatched(orgId: string, userId: string): Promise<{ appliedCount: number }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM bank_transactions WHERE org_id = $1 AND status = 'UNMATCHED' ORDER BY txn_date, id LIMIT 1000`,
      [orgId],
    );
    const settled = await applyRulesOnClient(
      client,
      orgId,
      userId,
      rows.map((r) => r.id),
    );
    return { appliedCount: settled.length };
  });
}
