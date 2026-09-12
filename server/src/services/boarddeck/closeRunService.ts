import { pool } from '../../db/connect.js';
import { withTransaction } from '../../db/transaction.js';
import * as fiscalPeriodService from '../ledger-core/fiscalPeriodService.js';
import * as reportService from '../ledger-core/reportService.js';
import { ApiError } from '../../utils/apiError.js';
import { canTransitionCloseRun } from '../../types/boarddeck.js';
import type {
  BoardDeckCloseCheck,
  BoardDeckCloseRun,
  BoardDeckCloseRunDetail,
  BoardDeckCloseRunStatus,
} from '../../types/boarddeck.js';
import type { FiscalPeriod } from '../../types/ledger-core.js';

/**
 * BoardDeck (Phase 15) — monthly close automation. This file contains ZERO
 * SQL against fiscal_periods, invoices, bills, ledger_lines, or
 * journal_entries. Its only routes into LedgerCore are
 * `fiscalPeriodService.getPeriodById`/`closePeriod` and
 * `reportService.closeReadiness` (guardrails rule 16).
 *
 * No REFERENCES fiscal_periods on boarddeck_close_runs.fiscal_period_id —
 * rules 8 and 16 collide, 16 wins (migration 042's header). Validity comes
 * from `fiscalPeriodService.getPeriodById`, which already 404s a
 * cross-tenant id.
 */

const PG_INVALID_TEXT_REPRESENTATION = '22P02';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface RunRow {
  id: string;
  fiscal_period_id: string;
  status: BoardDeckCloseRunStatus;
  // DATE columns come back as 'YYYY-MM-DD' strings — db/connect.ts overrides
  // pg's default DATE parser to avoid a timezone-shifted Date object.
  period_starts_on: string;
  period_ends_on: string;
  ran_at: Date;
  ran_by_name: string | null;
  closed_at: Date | null;
  closed_by_name: string | null;
  created_at: Date;
}

interface CheckRow {
  kind: BoardDeckCloseCheck['kind'];
  result: BoardDeckCloseCheck['result'];
  detail: string;
  observed_count: string;
}

const RUN_SELECT = `
  SELECT r.id, r.fiscal_period_id, r.status,
         r.period_starts_on, r.period_ends_on, r.ran_at,
         ran_by_user.name AS ran_by_name,
         r.closed_at,
         closed_by_user.name AS closed_by_name,
         r.created_at
    FROM boarddeck_close_runs r
    LEFT JOIN users ran_by_user    ON ran_by_user.id = r.ran_by
    LEFT JOIN users closed_by_user ON closed_by_user.id = r.closed_by
`;

function toCloseRun(row: RunRow): BoardDeckCloseRun {
  return {
    id: row.id,
    fiscalPeriodId: row.fiscal_period_id,
    status: row.status,
    periodStartsOn: row.period_starts_on,
    periodEndsOn: row.period_ends_on,
    ranAt: row.ran_at.toISOString(),
    ranByName: row.ran_by_name,
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    closedByName: row.closed_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listRuns(orgId: string): Promise<BoardDeckCloseRun[]> {
  const { rows } = await pool.query<RunRow>(`${RUN_SELECT} WHERE r.org_id = $1 ORDER BY r.ran_at DESC`, [orgId]);
  return rows.map(toCloseRun);
}

export async function getRunById(orgId: string, id: string): Promise<BoardDeckCloseRunDetail> {
  try {
    const { rows } = await pool.query<RunRow>(`${RUN_SELECT} WHERE r.org_id = $1 AND r.id = $2`, [orgId, id]);
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Close run not found');

    const { rows: checkRows } = await pool.query<CheckRow>(
      `SELECT kind, result, detail, observed_count FROM boarddeck_close_checks
        WHERE org_id = $1 AND run_id = $2 ORDER BY kind ASC`,
      [orgId, id],
    );

    return {
      ...toCloseRun(row),
      checks: checkRows.map((c) => ({
        kind: c.kind,
        result: c.result,
        detail: c.detail,
        observedCount: Number(c.observed_count),
      })),
    };
  } catch (err) {
    if (pgErrorCode(err) === PG_INVALID_TEXT_REPRESENTATION) {
      throw new ApiError(404, 'Close run not found');
    }
    throw err;
  }
}

/**
 * Computes the five close-readiness checks for a period from a single call
 * to reportService.closeReadiness (guardrails rule 16) plus the period's own
 * status. Not exported — createRun and rerunChecks are the only callers.
 */
async function computeChecks(orgId: string, period: FiscalPeriod): Promise<BoardDeckCloseCheck[]> {
  const r = await reportService.closeReadiness(orgId, period.startsOn, period.endsOn);
  const imbalance = Math.abs(r.totalDebitCents - r.totalCreditCents);

  const checks: BoardDeckCloseCheck[] = [
    {
      kind: 'PERIOD_OPEN',
      result: period.status === 'OPEN' ? 'PASS' : 'FAIL',
      detail: period.status === 'OPEN' ? '' : `Period is ${period.status}, not OPEN`,
      observedCount: 0,
    },
    {
      kind: 'TRIAL_BALANCE_BALANCED',
      result: r.totalDebitCents === r.totalCreditCents ? 'PASS' : 'FAIL',
      detail: r.totalDebitCents === r.totalCreditCents ? '' : `Debits and credits differ by ${String(imbalance)} cents`,
      observedCount: imbalance,
    },
    {
      kind: 'NO_DRAFT_INVOICES',
      result: r.draftInvoiceCount === 0 ? 'PASS' : 'FAIL',
      detail: r.draftInvoiceCount === 0 ? '' : `${String(r.draftInvoiceCount)} invoice(s) still in DRAFT`,
      observedCount: r.draftInvoiceCount,
    },
    {
      kind: 'NO_UNPOSTED_BILLS',
      result: r.unpostedBillCount === 0 ? 'PASS' : 'FAIL',
      detail: r.unpostedBillCount === 0 ? '' : `${String(r.unpostedBillCount)} bill(s) not yet POSTED`,
      observedCount: r.unpostedBillCount,
    },
    {
      kind: 'NO_UNMATCHED_BANK_LINES',
      result: r.unmatchedBankLineCount === 0 ? 'PASS' : 'FAIL',
      detail: r.unmatchedBankLineCount === 0 ? '' : `${String(r.unmatchedBankLineCount)} unmatched bank line(s)`,
      observedCount: r.unmatchedBankLineCount,
    },
  ];

  return checks;
}

export async function createRun(orgId: string, userId: string, fiscalPeriodId: string): Promise<BoardDeckCloseRunDetail> {
  const period = await fiscalPeriodService.getPeriodById(orgId, fiscalPeriodId);
  const checks = await computeChecks(orgId, period);
  const status: BoardDeckCloseRunStatus = checks.every((c) => c.result === 'PASS') ? 'READY' : 'BLOCKED';

  const id = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO boarddeck_close_runs
         (org_id, fiscal_period_id, status, period_starts_on, period_ends_on, ran_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (org_id, fiscal_period_id) DO NOTHING
       RETURNING id`,
      [orgId, fiscalPeriodId, status, period.startsOn, period.endsOn, userId],
    );

    const inserted = rows[0];
    if (inserted === undefined) {
      throw new ApiError(409, 'A close run already exists for this period');
    }

    for (const check of checks) {
      await client.query(
        `INSERT INTO boarddeck_close_checks (org_id, run_id, kind, result, detail, observed_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orgId, inserted.id, check.kind, check.result, check.detail, check.observedCount],
      );
    }

    return inserted.id;
  });

  return getRunById(orgId, id);
}

export async function rerunChecks(orgId: string, userId: string, id: string): Promise<BoardDeckCloseRunDetail> {
  const existing = await getRunById(orgId, id);
  if (existing.status === 'CLOSED') {
    throw new ApiError(409, 'This period has already been closed');
  }
  if (!canTransitionCloseRun(existing.status, 'IN_PROGRESS')) {
    throw new ApiError(409, `Cannot re-run checks from status ${existing.status}`);
  }

  const period = await fiscalPeriodService.getPeriodById(orgId, existing.fiscalPeriodId);
  const checks = await computeChecks(orgId, period);
  const status: BoardDeckCloseRunStatus = checks.every((c) => c.result === 'PASS') ? 'READY' : 'BLOCKED';

  await withTransaction(async (client) => {
    await client.query('DELETE FROM boarddeck_close_checks WHERE org_id = $1 AND run_id = $2', [orgId, id]);

    for (const check of checks) {
      await client.query(
        `INSERT INTO boarddeck_close_checks (org_id, run_id, kind, result, detail, observed_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orgId, id, check.kind, check.result, check.detail, check.observedCount],
      );
    }

    await client.query(
      `UPDATE boarddeck_close_runs SET status = $3, ran_at = now(), ran_by = $4
        WHERE org_id = $1 AND id = $2`,
      [orgId, id, status, userId],
    );
  });

  return getRunById(orgId, id);
}

export async function closePeriodFromRun(orgId: string, userId: string, id: string): Promise<BoardDeckCloseRunDetail> {
  const existing = await getRunById(orgId, id);
  if (existing.status !== 'READY') {
    throw new ApiError(409, 'Close run is not READY');
  }
  if (!canTransitionCloseRun('READY', 'CLOSED')) {
    throw new ApiError(409, 'Cannot close from READY');
  }

  // The only way this period is closed — never a direct UPDATE fiscal_periods
  // from this file (guardrails rule 16).
  await fiscalPeriodService.closePeriod(orgId, userId, existing.fiscalPeriodId);

  // Deliberately NOT in the same transaction as closePeriod, which owns its
  // own. If this UPDATE fails after the period closed, rerunChecks will
  // re-detect PERIOD_OPEN as FAIL and the run shows BLOCKED — honest rather
  // than silently wrong.
  await pool.query(
    `UPDATE boarddeck_close_runs SET status = 'CLOSED', closed_at = now(), closed_by = $3
      WHERE org_id = $1 AND id = $2 AND status = 'READY'`,
    [orgId, id, userId],
  );

  return getRunById(orgId, id);
}

/**
 * Phase 15's own bridge for deckBuilderService (Step C6): the close checks
 * for a period's most recent run, or [] when no run exists. Not a query
 * against fiscal_periods — fiscal_period_id is the id the caller already
 * validated.
 */
export async function findChecksForPeriod(orgId: string, fiscalPeriodId: string): Promise<BoardDeckCloseCheck[]> {
  const { rows: runRows } = await pool.query<{ id: string }>(
    'SELECT id FROM boarddeck_close_runs WHERE org_id = $1 AND fiscal_period_id = $2',
    [orgId, fiscalPeriodId],
  );
  const runId = runRows[0]?.id;
  if (runId === undefined) return [];

  const { rows } = await pool.query<CheckRow>(
    `SELECT kind, result, detail, observed_count FROM boarddeck_close_checks
      WHERE org_id = $1 AND run_id = $2 ORDER BY kind ASC`,
    [orgId, runId],
  );

  return rows.map((c) => ({
    kind: c.kind,
    result: c.result,
    detail: c.detail,
    observedCount: Number(c.observed_count),
  }));
}
