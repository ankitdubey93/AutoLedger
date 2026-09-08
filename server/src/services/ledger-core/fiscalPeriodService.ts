import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { beginTransaction } from '../../db/transaction.js';
import { ApiError } from '../../utils/apiError.js';
import { fiscalPeriodRanges, fiscalYearBounds } from '../../utils/fiscalYear.js';
import { emitEvent } from '../outboxService.js';
import {
  canTransitionFiscalPeriod,
  type FiscalPeriod,
  type FiscalPeriodStatus,
} from '../../types/ledger-core.js';

/**
 * LedgerCore fiscal periods — Phase 4's close/lock lifecycle.
 *
 * A missing period for a given date means "open" — absence of a period is
 * not a lock, so an organization that has never generated periods keeps
 * posting freely. `assertPeriodOpenOnClient` is the hook every posting path
 * (manual journals, invoice issuance, bill approval, payments) calls before
 * writing a journal entry, on the caller's own transaction client
 * (guardrails rule 5) — this file never opens a second connection mid-write.
 */

const PG_EXCLUSION_VIOLATION = '23P01';

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

interface PeriodRow {
  id: string;
  fiscal_year_label: string;
  period_number: number;
  starts_on: string;
  ends_on: string;
  status: string;
  closed_by: string | null;
  closed_at: Date | null;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  closed_by_name: string | null;
  locked_by_name: string | null;
  entry_count: string;
}

function toFiscalPeriod(row: PeriodRow): FiscalPeriod {
  return {
    id: row.id,
    fiscalYearLabel: row.fiscal_year_label,
    periodNumber: row.period_number,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status as FiscalPeriodStatus,
    closedBy: row.closed_by,
    closedByName: row.closed_by_name,
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    lockedBy: row.locked_by,
    lockedByName: row.locked_by_name,
    lockedAt: row.locked_at === null ? null : row.locked_at.toISOString(),
    entryCount: Number(row.entry_count),
    createdAt: row.created_at.toISOString(),
  };
}

const PERIOD_SELECT = `
  SELECT p.id, p.fiscal_year_label, p.period_number, p.starts_on, p.ends_on, p.status,
         p.closed_by, p.closed_at, p.locked_by, p.locked_at, p.created_at,
         cu.name AS closed_by_name,
         lu.name AS locked_by_name,
         (SELECT COUNT(*) FROM journal_entries e
           WHERE e.org_id = p.org_id
             AND e.entry_date BETWEEN p.starts_on AND p.ends_on) AS entry_count
    FROM fiscal_periods p
    LEFT JOIN users cu ON cu.id = p.closed_by
    LEFT JOIN users lu ON lu.id = p.locked_by`;

export async function listPeriods(
  orgId: string,
  options: { fiscalYearLabel: string | null; status: FiscalPeriodStatus | null },
): Promise<FiscalPeriod[]> {
  const { rows } = await pool.query<PeriodRow>(
    `${PERIOD_SELECT}
    WHERE p.org_id = $1
      AND ($2::text IS NULL OR p.fiscal_year_label = $2)
      AND ($3::text IS NULL OR p.status = $3)
    ORDER BY p.starts_on ASC`,
    [orgId, options.fiscalYearLabel, options.status],
  );
  return rows.map(toFiscalPeriod);
}

export async function getPeriodById(orgId: string, id: string): Promise<FiscalPeriod> {
  const { rows } = await pool.query<PeriodRow>(
    `${PERIOD_SELECT}
    WHERE p.org_id = $1 AND p.id = $2`,
    [orgId, id],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Fiscal period not found');
  return toFiscalPeriod(row);
}

/**
 * Generates the twelve monthly periods for the fiscal year containing
 * `containingDate`, using the organization's configured fiscal-year start.
 * Idempotent: a second call for the same fiscal year creates nothing and is
 * not an error — this is what lets a UI "generate" button be pressed twice
 * by accident without consequence.
 */
export async function generatePeriods(
  orgId: string,
  createdBy: string,
  containingDate: string,
): Promise<{ fiscalYearLabel: string; created: boolean; periods: FiscalPeriod[] }> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows: settingsRows } = await client.query<{
      fiscal_year_start_month: number | null;
      fiscal_year_start_day: number | null;
    }>('SELECT fiscal_year_start_month, fiscal_year_start_day FROM ledger_settings WHERE org_id = $1', [
      orgId,
    ]);
    const settings = settingsRows[0];
    if (settings === undefined) {
      throw new ApiError(409, 'Complete LedgerCore onboarding before generating fiscal periods');
    }
    const startMonth = settings.fiscal_year_start_month ?? 1;
    const startDay = settings.fiscal_year_start_day ?? 1;

    const { label, startDate, endDate } = fiscalYearBounds(startMonth, startDay, containingDate);

    const { rows: existingRows } = await client.query<{ id: string }>(
      `SELECT id FROM fiscal_periods
        WHERE org_id = $1
          AND daterange(starts_on, ends_on, '[]') && daterange($2::date, $3::date, '[]')
        LIMIT 1`,
      [orgId, startDate, endDate],
    );

    if (existingRows.length > 0) {
      await client.query('COMMIT');
      return {
        fiscalYearLabel: label,
        created: false,
        periods: await listPeriods(orgId, { fiscalYearLabel: label, status: null }),
      };
    }

    const ranges = fiscalPeriodRanges(startMonth, startDay, containingDate);

    await client.query(
      `INSERT INTO fiscal_periods (org_id, created_by, fiscal_year_label, period_number, starts_on, ends_on)
       SELECT $1, $2, $3, v.period_number, v.starts_on, v.ends_on
         FROM unnest($4::smallint[], $5::date[], $6::date[])
              AS v(period_number, starts_on, ends_on)`,
      [
        orgId,
        createdBy,
        label,
        ranges.map((r) => r.periodNumber),
        ranges.map((r) => r.startsOn),
        ranges.map((r) => r.endsOn),
      ],
    );

    await client.query('COMMIT');
    return {
      fiscalYearLabel: label,
      created: true,
      periods: await listPeriods(orgId, { fiscalYearLabel: label, status: null }),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    if (pgErrorCode(err) === PG_EXCLUSION_VIOLATION) {
      throw new ApiError(409, 'A fiscal period already overlaps this fiscal year');
    }
    throw err;
  } finally {
    client.release();
  }
}

async function transition(
  orgId: string,
  userId: string,
  id: string,
  to: FiscalPeriodStatus,
  verb: 'close' | 'reopen' | 'lock',
): Promise<FiscalPeriod> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);

    const { rows } = await client.query<{
      status: FiscalPeriodStatus;
      fiscal_year_label: string;
      period_number: number;
      starts_on: string;
      ends_on: string;
    }>(
      'SELECT status, fiscal_year_label, period_number, starts_on, ends_on FROM fiscal_periods WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Fiscal period not found');

    if (!canTransitionFiscalPeriod(row.status, to)) {
      throw new ApiError(409, `Cannot ${verb} a ${row.status.toLowerCase()} period`);
    }

    if (to === 'CLOSED') {
      await client.query(
        `UPDATE fiscal_periods SET status = 'CLOSED', closed_by = $3, closed_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, id, userId],
      );

      // Not on LOCKED and not on reopen: closing is the event a downstream
      // system acts on.
      await emitEvent(client, orgId, 'ledger-core', 'fiscal_period.closed', {
        periodId: id,
        fiscalYearLabel: row.fiscal_year_label,
        periodNumber: row.period_number,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        closedBy: userId,
      });
    } else if (to === 'OPEN') {
      await client.query(
        `UPDATE fiscal_periods
            SET status = 'OPEN', closed_by = NULL, closed_at = NULL, locked_by = NULL, locked_at = NULL
          WHERE org_id = $1 AND id = $2`,
        [orgId, id],
      );
    } else {
      await client.query(
        `UPDATE fiscal_periods SET status = 'LOCKED', locked_by = $3, locked_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, id, userId],
      );
    }

    await client.query('COMMIT');
    return await getPeriodById(orgId, id);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof ApiError) throw err;
    throw err;
  } finally {
    client.release();
  }
}

export async function closePeriod(orgId: string, userId: string, id: string): Promise<FiscalPeriod> {
  return transition(orgId, userId, id, 'CLOSED', 'close');
}

export async function reopenPeriod(orgId: string, userId: string, id: string): Promise<FiscalPeriod> {
  return transition(orgId, userId, id, 'OPEN', 'reopen');
}

export async function lockPeriod(orgId: string, userId: string, id: string): Promise<FiscalPeriod> {
  return transition(orgId, userId, id, 'LOCKED', 'lock');
}

/**
 * Throws 422 if `entryDate` falls inside a CLOSED or LOCKED period. A date
 * covered by no period at all is open — absence of a period is not a lock.
 * Runs on the caller's transaction client (guardrails rule 5).
 */
export async function assertPeriodOpenOnClient(
  client: PoolClient,
  orgId: string,
  entryDate: string,
): Promise<void> {
  const { rows } = await client.query<{ status: FiscalPeriodStatus }>(
    `SELECT status FROM fiscal_periods
      WHERE org_id = $1 AND $2::date BETWEEN starts_on AND ends_on`,
    [orgId, entryDate],
  );
  const row = rows[0];
  if (row === undefined || row.status === 'OPEN') return;

  throw new ApiError(
    422,
    `The fiscal period covering ${entryDate} is ${row.status.toLowerCase()}; reopen it or post to an open period`,
  );
}
