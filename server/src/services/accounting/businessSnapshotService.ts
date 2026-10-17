import { pool } from '../../db/connect.js';
import { parseCents } from '../../utils/money.js';
import { comparisonPeriods } from '../../utils/comparisonPeriods.js';
import { deriveBalanceSheetClass } from '../../utils/balanceSheetClass.js';
import { buildRatios, ratioBp } from '../../utils/financialRatios.js';
import {
  isAccountType,
  isBalanceSheetClass,
  type AccountType,
  type BalanceSheetClass,
  type BusinessSnapshot,
  type SnapshotAging,
  type SnapshotPerformance,
  type SnapshotPosition,
  type SnapshotTrendPoint,
} from '../../types/accounting.js';
import { profitAndLoss } from './reportService.js';
import { apAging, arAging } from './agingService.js';

/**
 * The business snapshot (Phase 47): performance, position, ratios, aging and a
 * 12-month trend, current period against the period immediately before.
 *
 * Read-only aggregates over the ledger, base-currency cents throughout. No
 * transaction, like the other reports.
 */

interface ClassQueryRow {
  id: string;
  type: string;
  balance_sheet_class: string | null;
  codes: string[];
}

interface BalanceQueryRow {
  account_id: string;
  idx: number;
  debit_cents: string;
  credit_cents: string;
}

interface PnlQueryRow {
  idx: number;
  revenue_cents: string;
  cost_of_sales_cents: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Exactly 12 windows ending with the month containing `to`, oldest first. */
export function snapshotTrendWindows(to: string): { month: string; from: string; to: string }[] {
  const year = Number(to.slice(0, 4));
  const monthIndex = Number(to.slice(5, 7)) - 1;
  const windows: { month: string; from: string; to: string }[] = [];
  for (let k = 11; k >= 0; k--) {
    const first = new Date(Date.UTC(year, monthIndex - k, 1));
    const y = first.getUTCFullYear();
    const m = first.getUTCMonth();
    const month = `${y}-${pad2(m + 1)}`;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    windows.push({
      month,
      from: `${month}-01`,
      to: k === 0 ? to : `${month}-${pad2(lastDay)}`,
    });
  }
  return windows;
}

function emptyPosition(asOf: string): SnapshotPosition {
  return {
    asOf,
    currentAssetsCents: 0,
    nonCurrentAssetsCents: 0,
    totalAssetsCents: 0,
    currentLiabilitiesCents: 0,
    nonCurrentLiabilitiesCents: 0,
    totalLiabilitiesCents: 0,
    netWorthCents: 0,
    workingCapitalCents: 0,
  };
}

function toAging(report: {
  asOf: string;
  buckets: SnapshotAging['buckets'];
  totalOutstandingCents: number;
  totalOverdueCents: number;
}): SnapshotAging {
  return {
    asOf: report.asOf,
    buckets: report.buckets,
    totalOutstandingCents: report.totalOutstandingCents,
    totalOverdueCents: report.totalOverdueCents,
  };
}

export async function businessSnapshot(
  orgId: string,
  from: string | null,
  to: string | null,
): Promise<BusinessSnapshot> {
  // Resolves the default window and raises the 422 exactly as the P&L does.
  const pnl = await profitAndLoss(orgId, from, to);
  const [, prior] = comparisonPeriods(pnl.from, pnl.to, 'previousPeriod', 1);
  if (!prior) throw new Error('No prior period could be derived');
  const priorPnl = await profitAndLoss(orgId, prior.from, prior.to);
  const windows = snapshotTrendWindows(pnl.to);

  // A — current / non-current class of every Asset and Liability account.
  const classRows = await pool.query<ClassQueryRow>(
    `WITH RECURSIVE ancestry AS (
       SELECT a.id AS account_id, a.parent_id, ARRAY[]::text[] AS codes
         FROM accounts a WHERE a.org_id = $1 AND a.type IN ('Asset', 'Liability')
       UNION ALL
       SELECT an.account_id, p.parent_id, an.codes || p.code
         FROM ancestry an JOIN accounts p ON p.id = an.parent_id AND p.org_id = $1
     ), paths AS (
       SELECT account_id, codes FROM ancestry WHERE parent_id IS NULL
     )
     SELECT a.id, a.type, a.balance_sheet_class, p.codes
       FROM accounts a JOIN paths p ON p.account_id = a.id
      WHERE a.org_id = $1`,
    [orgId],
  );

  const classes = new Map<string, { type: AccountType; cls: BalanceSheetClass | null }>();
  for (const row of classRows.rows) {
    if (!isAccountType(row.type)) {
      throw new Error(`Unknown account type "${row.type}" on account ${row.id}`);
    }
    if (row.balance_sheet_class !== null && !isBalanceSheetClass(row.balance_sheet_class)) {
      throw new Error(`Unknown balance sheet class "${row.balance_sheet_class}" on account ${row.id}`);
    }
    classes.set(row.id, {
      type: row.type,
      cls: deriveBalanceSheetClass({
        type: row.type,
        ancestorCodes: row.codes,
        override: row.balance_sheet_class,
      }),
    });
  }

  // B — Asset / Liability balances at the 12 trend dates (idx 1–12) and the prior end (idx 13).
  const asOfDates = [...windows.map((w) => w.to), prior.to];
  const balanceRows = await pool.query<BalanceQueryRow>(
    `SELECT l.account_id, p.idx::int AS idx,
            SUM(l.base_debit_cents)::text  AS debit_cents,
            SUM(l.base_credit_cents)::text AS credit_cents
       FROM unnest($2::date[]) WITH ORDINALITY AS p(as_of, idx)
       JOIN journal_entries e ON e.org_id = $1 AND e.entry_date <= p.as_of
       JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = $1
       JOIN accounts a        ON a.id = l.account_id AND a.org_id = $1
      WHERE a.type IN ('Asset', 'Liability')
      GROUP BY l.account_id, p.idx`,
    [orgId, asOfDates],
  );

  const positions: SnapshotPosition[] = asOfDates.map((d) => emptyPosition(d));
  for (const row of balanceRows.rows) {
    const info = classes.get(row.account_id);
    if (!info) throw new Error(`Account ${row.account_id} missing from the class map`);
    const position = positions[row.idx - 1];
    if (!position) throw new Error(`Unexpected balance index ${row.idx}`);
    const debit = parseCents(row.debit_cents);
    const credit = parseCents(row.credit_cents);
    if (info.type === 'Asset') {
      const balance = debit - credit;
      if (info.cls === 'NON_CURRENT') position.nonCurrentAssetsCents += balance;
      else position.currentAssetsCents += balance;
    } else {
      const balance = credit - debit;
      if (info.cls === 'NON_CURRENT') position.nonCurrentLiabilitiesCents += balance;
      else position.currentLiabilitiesCents += balance;
    }
  }
  for (const p of positions) {
    p.totalAssetsCents = p.currentAssetsCents + p.nonCurrentAssetsCents;
    p.totalLiabilitiesCents = p.currentLiabilitiesCents + p.nonCurrentLiabilitiesCents;
    p.netWorthCents = p.totalAssetsCents - p.totalLiabilitiesCents;
    p.workingCapitalCents = p.currentAssetsCents - p.currentLiabilitiesCents;
  }

  // C — monthly revenue and cost of sales for the trend.
  const pnlRows = await pool.query<PnlQueryRow>(
    `SELECT p.idx::int AS idx,
            COALESCE(SUM(l.base_credit_cents - l.base_debit_cents) FILTER (WHERE a.type = 'Revenue'), 0)::text AS revenue_cents,
            COALESCE(SUM(l.base_debit_cents - l.base_credit_cents)
                     FILTER (WHERE a.type = 'Expense' AND a.code LIKE '5%'), 0)::text AS cost_of_sales_cents
       FROM unnest($2::date[], $3::date[]) WITH ORDINALITY AS p(from_date, to_date, idx)
       JOIN journal_entries e ON e.org_id = $1 AND e.entry_date >= p.from_date AND e.entry_date <= p.to_date
       JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = $1
       JOIN accounts a        ON a.id = l.account_id AND a.org_id = $1
      WHERE a.type IN ('Revenue', 'Expense')
      GROUP BY p.idx`,
    [orgId, windows.map((w) => w.from), windows.map((w) => w.to)],
  );
  const monthly = new Map<number, { revenue: number; costOfSales: number }>();
  for (const row of pnlRows.rows) {
    monthly.set(row.idx, {
      revenue: parseCents(row.revenue_cents),
      costOfSales: parseCents(row.cost_of_sales_cents),
    });
  }

  const trend: SnapshotTrendPoint[] = windows.map((w, i) => {
    const m = monthly.get(i + 1) ?? { revenue: 0, costOfSales: 0 };
    const pos = positions[i];
    if (!pos) throw new Error(`Missing trend position ${i}`);
    const grossProfitCents = m.revenue - m.costOfSales;
    return {
      month: w.month,
      asOf: w.to,
      revenueCents: m.revenue,
      costOfSalesCents: m.costOfSales,
      grossProfitCents,
      grossMarginBp: ratioBp(grossProfitCents, m.revenue).valueBp,
      currentRatioBp: ratioBp(pos.currentAssetsCents, pos.currentLiabilitiesCents).valueBp,
      debtRatioBp: ratioBp(pos.totalLiabilitiesCents, pos.totalAssetsCents).valueBp,
      debtToEquityBp: ratioBp(pos.totalLiabilitiesCents, pos.netWorthCents).valueBp,
    };
  });

  const toPerformance = (r: typeof pnl): SnapshotPerformance => ({
    revenueCents: r.revenue.totalCents,
    costOfSalesCents: r.costOfSales.totalCents,
    grossProfitCents: r.grossProfitCents,
    operatingExpensesCents: r.operatingExpenses.totalCents,
    netIncomeCents: r.netIncomeCents,
  });
  const currentPerformance = toPerformance(pnl);
  const priorPerformance = toPerformance(priorPnl);

  const currentPosition = positions[11];
  const priorPosition = positions[12];
  if (!currentPosition || !priorPosition) throw new Error('Missing snapshot positions');

  const ratios = buildRatios(
    { performance: currentPerformance, position: currentPosition },
    { performance: priorPerformance, position: priorPosition },
  );

  const [ar, ap] = await Promise.all([arAging(orgId, pnl.to), apAging(orgId, pnl.to)]);

  return {
    period: { from: pnl.from, to: pnl.to },
    priorPeriod: { from: prior.from, to: prior.to },
    performance: { current: currentPerformance, prior: priorPerformance },
    position: { current: currentPosition, prior: priorPosition },
    ratios,
    receivables: toAging(ar),
    payables: toAging(ap),
    trend,
  };
}
