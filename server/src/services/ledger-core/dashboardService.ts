import { pool } from '../../db/connect.js';
import { parseCents } from '../../utils/money.js';
import { fiscalYearBounds, monthBounds, monthsBackStart } from '../../utils/fiscalYear.js';
import { getSettings } from './settingsService.js';
import { listEntries } from './journalService.js';
import { arAging, apAging } from './agingService.js';
import type { DashboardSummary, TrendPoint } from '../../types/ledger-core.js';

/**
 * LedgerCore's dashboard, computed from raw `ledger_lines` on every request.
 *
 * **There is no summary table and none will be added** — the same rule
 * `reportService.trialBalance` states for the same reason: a cached balance
 * column is a second source of truth that drifts from the lines it
 * summarises, and reconciling the two is the manual work this system exists
 * to remove.
 *
 * Every sum is over the `base_*` columns, never the native ones — a report
 * mixing currencies would be meaningless, and base currency is the
 * organization's functional currency by definition.
 */

interface PositionRow {
  assets: string;
  liabilities: string;
  equity: string;
  revenue_all: string;
  expense_all: string;
  revenue_ytd: string;
  expense_ytd: string;
  revenue_month: string;
  expense_month: string;
  entry_count_ytd: string;
}

interface CashRow {
  cash: string;
}

interface IntegrityRow {
  d: string;
  c: string;
}

interface TrendRow {
  month: string;
  revenue: string;
  expense: string;
}

async function loadPosition(orgId: string, fyStart: string, monthStart: string, asOf: string): Promise<PositionRow> {
  const { rows } = await pool.query<PositionRow>(
    `SELECT
       COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Asset'),     0)::text AS assets,
       COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Liability'), 0)::text AS liabilities,
       COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Equity'),    0)::text AS equity,
       COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Revenue'),   0)::text AS revenue_all,
       COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Expense'),   0)::text AS expense_all,
       COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Revenue' AND e.entry_date >= $2::date), 0)::text AS revenue_ytd,
       COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Expense' AND e.entry_date >= $2::date), 0)::text AS expense_ytd,
       COALESCE(SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Revenue' AND e.entry_date >= $3::date), 0)::text AS revenue_month,
       COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Expense' AND e.entry_date >= $3::date), 0)::text AS expense_month,
       COUNT(DISTINCT e.id) FILTER (WHERE e.entry_date >= $2::date)::text AS entry_count_ytd
     FROM ledger_lines l
     JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
     JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
    WHERE l.org_id = $1
      AND e.entry_date <= $4::date`,
    [orgId, fyStart, monthStart, asOf],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('position aggregate produced no row');
  return row;
}

/**
 * Sums every posting under the configured cash account's subtree.
 *
 * `org_id = $1` appears in BOTH the anchor and the recursive term of the CTE
 * — omitting it from the recursive term would let the walk cross into another
 * tenant's tree (guardrails rule 1), mirroring accountService's cycle check.
 */
async function loadCash(orgId: string, cashAccountId: string, asOf: string): Promise<number> {
  const { rows } = await pool.query<CashRow>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM accounts WHERE org_id = $1 AND id = $2
       UNION ALL
       SELECT a.id FROM accounts a JOIN subtree s ON a.parent_id = s.id WHERE a.org_id = $1
     )
     SELECT COALESCE(SUM(l.base_debit_cents - l.base_credit_cents), 0)::text AS cash
       FROM ledger_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.account_id IN (SELECT id FROM subtree)
        AND e.entry_date <= $3::date`,
    [orgId, cashAccountId, asOf],
  );
  const row = rows[0];
  return parseCents(row?.cash ?? '0');
}

async function loadIntegrity(orgId: string): Promise<IntegrityRow> {
  const { rows } = await pool.query<IntegrityRow>(
    `SELECT COALESCE(SUM(base_debit_cents), 0)::text  AS d,
            COALESCE(SUM(base_credit_cents), 0)::text AS c
       FROM ledger_lines WHERE org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('integrity aggregate produced no row');
  return row;
}

/**
 * Six calendar months, oldest first, gap-filled by `generate_series` so a
 * month with no postings comes back as a zero row rather than a gap the
 * client has to invent.
 *
 * The `org_id` predicate sits in the LEFT JOIN's ON clause, not the WHERE —
 * moving it to WHERE would silently turn this into an INNER JOIN and drop
 * every empty month, the same warning reportService.trialBalance carries for
 * its own LEFT JOIN.
 */
async function loadTrend(orgId: string, trendFrom: string, monthStart: string): Promise<TrendPoint[]> {
  const { rows } = await pool.query<TrendRow>(
    `WITH months AS (
       SELECT generate_series($2::date, $3::date, INTERVAL '1 month')::date AS month_start
     )
     SELECT to_char(m.month_start, 'YYYY-MM') AS month,
            COALESCE(SUM(l.base_credit_cents - l.base_debit_cents) FILTER (WHERE a.type = 'Revenue'), 0)::text AS revenue,
            COALESCE(SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Expense'), 0)::text AS expense
       FROM months m
       LEFT JOIN journal_entries e ON e.org_id = $1
                                  AND e.entry_date >= m.month_start
                                  AND e.entry_date <  (m.month_start + INTERVAL '1 month')::date
       LEFT JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = e.org_id
       LEFT JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
      GROUP BY m.month_start
      ORDER BY m.month_start ASC`,
    [orgId, trendFrom, monthStart],
  );

  return rows.map((row) => ({
    month: row.month,
    revenueCents: parseCents(row.revenue),
    expenseCents: parseCents(row.expense),
  }));
}

interface DocumentCountsRow {
  invoice_draft_count: string;
  invoice_draft_cents: string;
  bill_draft_count: string;
  bill_draft_cents: string;
  bill_review_count: string;
  bill_review_cents: string;
}

/**
 * Draft/in-review counts and sums for invoices and bills, in one round trip
 * via `FILTER`-clause aggregates over a `UNION ALL` of the two tables — the
 * same idiom `loadPosition` already uses. `org_id = $1` appears in BOTH arms
 * of the `UNION ALL`; omitting it from either is a tenant leak.
 */
async function loadDocumentCounts(orgId: string): Promise<DocumentCountsRow> {
  const { rows } = await pool.query<DocumentCountsRow>(
    `SELECT
       COUNT(*) FILTER (WHERE kind = 'INVOICE' AND status = 'DRAFT')::text AS invoice_draft_count,
       COALESCE(SUM(total_cents) FILTER (WHERE kind = 'INVOICE' AND status = 'DRAFT'), 0)::text AS invoice_draft_cents,
       COUNT(*) FILTER (WHERE kind = 'BILL' AND status = 'DRAFT')::text AS bill_draft_count,
       COALESCE(SUM(total_cents) FILTER (WHERE kind = 'BILL' AND status = 'DRAFT'), 0)::text AS bill_draft_cents,
       COUNT(*) FILTER (WHERE kind = 'BILL' AND status = 'AWAITING_APPROVAL')::text AS bill_review_count,
       COALESCE(SUM(total_cents) FILTER (WHERE kind = 'BILL' AND status = 'AWAITING_APPROVAL'), 0)::text AS bill_review_cents
     FROM (
       SELECT 'INVOICE' AS kind, status, total_cents FROM invoices WHERE org_id = $1
       UNION ALL
       SELECT 'BILL'    AS kind, status, total_cents FROM bills    WHERE org_id = $1
     ) d`,
    [orgId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('document counts aggregate produced no row');
  return row;
}

export async function dashboardSummary(orgId: string, asOf: string | null): Promise<DashboardSummary> {
  const settings = await getSettings(orgId);
  const on = asOf ?? new Date().toISOString().slice(0, 10);
  const fy = fiscalYearBounds(settings.fiscalYearStartMonth, settings.fiscalYearStartDay, on);
  const month = monthBounds(on);
  const trendFrom = monthsBackStart(on, 6);

  const [position, cashCents, integrity, trend, { entries: recentEntries }, receivablesAging, payablesAging, documentCounts] =
    await Promise.all([
      loadPosition(orgId, fy.startDate, month.startDate, on),
      settings.cashAccountId === null ? Promise.resolve(null) : loadCash(orgId, settings.cashAccountId, on),
      loadIntegrity(orgId),
      loadTrend(orgId, trendFrom, month.startDate),
      listEntries(orgId, {
        page: 1,
        limit: 5,
        from: null,
        to: null,
        accountId: null,
        sourceType: null,
        q: null,
      }),
      arAging(orgId, on),
      apAging(orgId, on),
      loadDocumentCounts(orgId),
    ]);

  const assetsCents = parseCents(position.assets);
  const liabilitiesCents = parseCents(position.liabilities);
  const equityCents = parseCents(position.equity);
  const currentEarningsCents = parseCents(position.revenue_all) - parseCents(position.expense_all);

  const revenueYtdCents = parseCents(position.revenue_ytd);
  const expenseYtdCents = parseCents(position.expense_ytd);
  const revenueMonthCents = parseCents(position.revenue_month);
  const expenseMonthCents = parseCents(position.expense_month);

  const totalDebitCents = parseCents(integrity.d);
  const totalCreditCents = parseCents(integrity.c);

  return {
    asOf: on,
    fiscalYear: fy,
    position: {
      assetsCents,
      liabilitiesCents,
      equityCents,
      currentEarningsCents,
      cashCents,
      // Integer equality — guardrails rule 3.
      equationHolds: assetsCents === liabilitiesCents + equityCents + currentEarningsCents,
    },
    performance: {
      yearToDate: {
        revenueCents: revenueYtdCents,
        expenseCents: expenseYtdCents,
        netIncomeCents: revenueYtdCents - expenseYtdCents,
      },
      currentMonth: {
        revenueCents: revenueMonthCents,
        expenseCents: expenseMonthCents,
        netIncomeCents: revenueMonthCents - expenseMonthCents,
      },
    },
    activity: {
      entryCountYtd: Number(position.entry_count_ytd),
      recentEntries,
    },
    integrity: {
      totalDebitCents,
      totalCreditCents,
      isBalanced: totalDebitCents === totalCreditCents,
    },
    trend,
    receivables: {
      outstandingCents: receivablesAging.totalOutstandingCents,
      overdueCents: receivablesAging.totalOverdueCents,
      draftCount: Number(documentCounts.invoice_draft_count),
      draftCents: parseCents(documentCounts.invoice_draft_cents),
      buckets: receivablesAging.buckets,
    },
    payables: {
      outstandingCents: payablesAging.totalOutstandingCents,
      overdueCents: payablesAging.totalOverdueCents,
      draftCount: Number(documentCounts.bill_draft_count),
      draftCents: parseCents(documentCounts.bill_draft_cents),
      awaitingReviewCount: Number(documentCounts.bill_review_count),
      awaitingReviewCents: parseCents(documentCounts.bill_review_cents),
      buckets: payablesAging.buckets,
    },
  };
}
