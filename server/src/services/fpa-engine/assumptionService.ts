import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import * as accountService from '../ledger-core/accountService.js';
import type { FpaAssumption, FpaAssumptionKind } from '../../types/fpa-engine.js';

/**
 * FP&A Engine (Phase 12) — per-scenario, per-account assumptions.
 *
 * This file contains ZERO queries against `accounts`, `ledger_lines`,
 * `journal_entries`, `ledger_settings` or any other LedgerCore table — every
 * account fact it needs comes from `accountService`'s exported functions
 * (guardrails rule 16). `fpa_assumptions.account_id` carries no `REFERENCES`
 * (migration 034's ruling); validity is enforced here instead, via
 * `accountService.getAccountById`'s own cross-tenant 404.
 */

interface AssumptionRow {
  id: string;
  scenario_id: string;
  account_id: string;
  kind: FpaAssumptionKind;
  growth_bps: number | null;
  fixed_cents: string | null;
  percent_of_revenue_bps: number | null;
  created_at: Date;
  updated_at: Date;
}

async function verifyScenarioBelongsToOrg(orgId: string, scenarioId: string): Promise<void> {
  const { rows } = await pool.query('SELECT 1 FROM fpa_scenarios WHERE org_id = $1 AND id = $2', [
    orgId,
    scenarioId,
  ]);
  if (rows.length === 0) throw new ApiError(404, 'Scenario not found');
}

export async function listAssumptions(orgId: string, scenarioId: string): Promise<FpaAssumption[]> {
  await verifyScenarioBelongsToOrg(orgId, scenarioId);

  const { rows } = await pool.query<AssumptionRow>(
    `SELECT id, scenario_id, account_id, kind, growth_bps, fixed_cents::text AS fixed_cents,
            percent_of_revenue_bps, created_at, updated_at
       FROM fpa_assumptions
      WHERE org_id = $1 AND scenario_id = $2
      ORDER BY created_at ASC`,
    [orgId, scenarioId],
  );

  // Joined in TypeScript, not SQL — this file may not query `accounts`
  // directly (rule 16). An assumption whose account_id no longer resolves
  // falls back to placeholder text; accounts are retired via is_active =
  // false and never deleted, so this is not a reachable state in practice,
  // but the mapper must not crash if it somehow happened.
  const accounts = await accountService.listAccounts(orgId, { includeInactive: true });
  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  return rows.map((row) => {
    const account = accountsById.get(row.account_id);
    return {
      id: row.id,
      scenarioId: row.scenario_id,
      accountId: row.account_id,
      accountCode: account?.code ?? '',
      accountName: account?.name ?? '(unknown account)',
      accountType: account?.type ?? 'Expense',
      kind: row.kind,
      growthBps: row.growth_bps,
      fixedCents: row.fixed_cents === null ? null : Number(row.fixed_cents),
      percentOfRevenueBps: row.percent_of_revenue_bps,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export async function upsertAssumption(
  orgId: string,
  scenarioId: string,
  accountId: string,
  input:
    | { kind: 'GROWTH_BPS'; growthBps: number }
    | { kind: 'FIXED_CENTS'; fixedCents: number }
    | { kind: 'PERCENT_OF_REVENUE_BPS'; percentOfRevenueBps: number },
): Promise<FpaAssumption> {
  await verifyScenarioBelongsToOrg(orgId, scenarioId);

  // getAccountById's own 404 propagates for a cross-tenant or unknown
  // accountId — this is what makes an invalid accountId a 404 rather than a
  // silently stored orphan.
  const account = await accountService.getAccountById(orgId, accountId);

  if (!account.isPostable || !account.isActive) {
    throw new ApiError(422, 'Assumptions can only be set on a postable, active account');
  }
  if (account.type !== 'Revenue' && account.type !== 'Expense') {
    throw new ApiError(422, 'Assumptions apply to Revenue and Expense accounts only');
  }
  // The circular-reference guard the projection engine's two-pass design
  // depends on: a revenue account can never be defined as a percentage of
  // revenue.
  if (input.kind === 'PERCENT_OF_REVENUE_BPS' && account.type === 'Revenue') {
    throw new ApiError(422, 'A revenue account cannot be a percentage of revenue');
  }

  const growthBps = input.kind === 'GROWTH_BPS' ? input.growthBps : null;
  const fixedCents = input.kind === 'FIXED_CENTS' ? input.fixedCents : null;
  const percentOfRevenueBps = input.kind === 'PERCENT_OF_REVENUE_BPS' ? input.percentOfRevenueBps : null;

  const row = await withTransaction(async (client) => {
    const { rows } = await client.query<AssumptionRow>(
      `INSERT INTO fpa_assumptions (org_id, scenario_id, account_id, kind, growth_bps, fixed_cents, percent_of_revenue_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, scenario_id, account_id)
       DO UPDATE SET kind = EXCLUDED.kind, growth_bps = EXCLUDED.growth_bps,
                      fixed_cents = EXCLUDED.fixed_cents, percent_of_revenue_bps = EXCLUDED.percent_of_revenue_bps
       RETURNING id, scenario_id, account_id, kind, growth_bps, fixed_cents::text AS fixed_cents,
                 percent_of_revenue_bps, created_at, updated_at`,
      [orgId, scenarioId, accountId, input.kind, growthBps, fixedCents, percentOfRevenueBps],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('INSERT ... RETURNING produced no row');
    return r;
  });

  return {
    id: row.id,
    scenarioId: row.scenario_id,
    accountId: row.account_id,
    accountCode: account.code,
    accountName: account.name,
    accountType: account.type,
    kind: row.kind,
    growthBps: row.growth_bps,
    fixedCents: row.fixed_cents === null ? null : Number(row.fixed_cents),
    percentOfRevenueBps: row.percent_of_revenue_bps,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function deleteAssumption(orgId: string, scenarioId: string, accountId: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query(
      'DELETE FROM fpa_assumptions WHERE org_id = $1 AND scenario_id = $2 AND account_id = $3',
      [orgId, scenarioId, accountId],
    );
    if (result.rowCount === 0) throw new ApiError(404, 'Assumption not found');
  });
}
