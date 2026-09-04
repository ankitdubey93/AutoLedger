import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import { fiscalYearBounds } from '../../utils/fiscalYear.js';
import {
  isAccountType,
  type BalanceSheet,
  type ProfitAndLoss,
  type StatementRow,
  type StatementSection,
  type TrialBalance,
  type TrialBalanceRow,
} from '../../types/ledger-core.js';

/**
 * Financial statements, computed from raw `ledger_lines` on every request.
 *
 * **There is no summary table and none will be added.** A cached
 * `account_balances` column is a second source of truth that drifts from the
 * lines it summarises, and reconciling the two is the manual work this system
 * exists to remove. Postgres aggregates a few thousand rows in single-digit
 * milliseconds; when that stops being true the answer is a materialized view
 * with an explicit refresh, not a column updated by hand.
 *
 * `profitAndLoss` and `balanceSheet` (Phase 4) follow the same rule: no
 * pre-calculated retained-earnings column, no nightly rollup — see each
 * function's own comment for how retained earnings is derived instead.
 */

interface TrialBalanceRowResult {
  account_id: string;
  code: string;
  name: string;
  type: string;
  debit_cents: string;
  credit_cents: string;
}

/**
 * Per-account debit and credit totals, and the proof that the books balance.
 *
 * Sums the **base_** columns, not the native ones: a report mixing currencies
 * would be meaningless, and base currency is the organization's functional
 * currency by definition. Until Phase 8 the two are identical anyway.
 *
 * Only postable accounts appear — a header account like `1000 Assets` has no
 * lines of its own, and listing it with zeros would imply it could have some.
 */
export async function trialBalance(orgId: string, asOf: string | null): Promise<TrialBalance> {
  const { rows } = await pool.query<TrialBalanceRowResult>(
    `SELECT a.id AS account_id,
            a.code,
            a.name,
            a.type,
            COALESCE(SUM(l.base_debit_cents),  0)::text AS debit_cents,
            COALESCE(SUM(l.base_credit_cents), 0)::text AS credit_cents
       FROM accounts a
       -- LEFT JOIN so an account with no postings still appears, at zero.
       -- The org_id predicate sits in the JOIN condition as well as the WHERE:
       -- on a LEFT JOIN, moving it to the WHERE clause would silently turn this
       -- into an INNER JOIN and drop every unposted account.
       LEFT JOIN ledger_lines l
              ON l.account_id = a.id
             AND l.org_id = a.org_id
       LEFT JOIN journal_entries e
              ON e.id = l.journal_entry_id
             AND e.org_id = a.org_id
             AND ($2::date IS NULL OR e.entry_date <= $2::date)
      WHERE a.org_id = $1
        AND a.is_postable
        AND a.is_active
        -- Excludes lines whose entry fell outside the asOf window; without it
        -- the LEFT JOIN would keep the line with a NULL entry.
        AND (l.id IS NULL OR e.id IS NOT NULL)
      GROUP BY a.id, a.code, a.name, a.type
      ORDER BY a.code ASC`,
    [orgId, asOf],
  );

  let totalDebitCents = 0;
  let totalCreditCents = 0;

  const trialBalanceRows: TrialBalanceRow[] = rows.map((row) => {
    if (!isAccountType(row.type)) {
      throw new Error(`Unknown account type "${row.type}" on account ${row.account_id}`);
    }

    const debitCents = parseCents(row.debit_cents);
    const creditCents = parseCents(row.credit_cents);
    totalDebitCents += debitCents;
    totalCreditCents += creditCents;

    // Type-aware: an Asset or Expense carries a debit balance, so debits are
    // positive for them; everything else carries a credit balance. Reporting a
    // raw `debit - credit` for a Revenue account would show all income negative.
    const isDebitBalance = row.type === 'Asset' || row.type === 'Expense';

    return {
      accountId: row.account_id,
      code: row.code,
      name: row.name,
      type: row.type,
      debitCents,
      creditCents,
      netBalanceCents: isDebitBalance ? debitCents - creditCents : creditCents - debitCents,
    };
  });

  return {
    asOf,
    rows: trialBalanceRows,
    totalDebitCents,
    totalCreditCents,
    // Integer equality — guardrails rule 3. An epsilon here is the exact bug
    // that sank the previous build.
    isBalanced: totalDebitCents === totalCreditCents,
  };
}

// -------------------------------------------------- Phase 4 — live statements

interface StatementRowResult {
  account_id: string;
  code: string;
  name: string;
  type: string;
  debit_cents: string;
  credit_cents: string;
}

async function fiscalYearStart(orgId: string): Promise<{ month: number; day: number }> {
  const { rows } = await pool.query<{
    fiscal_year_start_month: number | null;
    fiscal_year_start_day: number | null;
  }>('SELECT fiscal_year_start_month, fiscal_year_start_day FROM ledger_settings WHERE org_id = $1', [
    orgId,
  ]);
  return {
    month: rows[0]?.fiscal_year_start_month ?? 1,
    day: rows[0]?.fiscal_year_start_day ?? 1,
  };
}

/**
 * Revenue − Expenses over [from, to], with the 5xxx range split out as cost
 * of sales (Cost of Goods Sold is NOT a sixth account type — the split is by
 * code prefix, exactly as migration 002's header comment establishes).
 *
 * Defaults `to` to today and `from` to the start of the fiscal year
 * containing `to`, so a bare GET returns "this fiscal year to date".
 */
export async function profitAndLoss(
  orgId: string,
  from: string | null,
  to: string | null,
): Promise<ProfitAndLoss> {
  const today = new Date().toISOString().slice(0, 10);
  const resolvedTo = to ?? today;
  const { month, day } = await fiscalYearStart(orgId);
  const fy = fiscalYearBounds(month, day, resolvedTo);
  const resolvedFrom = from ?? fy.startDate;

  if (resolvedFrom > resolvedTo) throw new ApiError(422, 'from must not be after to');

  const { rows } = await pool.query<StatementRowResult>(
    `SELECT a.id AS account_id, a.code, a.name, a.type,
            COALESCE(SUM(l.base_debit_cents),  0)::text AS debit_cents,
            COALESCE(SUM(l.base_credit_cents), 0)::text AS credit_cents
       FROM accounts a
       -- INNER JOIN, unlike trialBalance's LEFT JOIN. The trial balance must
       -- list every account because it is the proof the books balance; a P&L
       -- lists the accounts that had activity in the window, and a page of
       -- zero rows is noise, not rigour.
       JOIN ledger_lines l    ON l.account_id = a.id           AND l.org_id = a.org_id
       JOIN journal_entries e ON e.id = l.journal_entry_id     AND e.org_id = a.org_id
      WHERE a.org_id = $1
        AND a.type IN ('Revenue', 'Expense')
        AND e.entry_date >= $2::date
        AND e.entry_date <= $3::date
      GROUP BY a.id, a.code, a.name, a.type
      ORDER BY a.code ASC`,
    [orgId, resolvedFrom, resolvedTo],
  );

  const revenue: StatementRow[] = [];
  const costOfSales: StatementRow[] = [];
  const operatingExpenses: StatementRow[] = [];

  for (const row of rows) {
    if (!isAccountType(row.type)) {
      throw new Error(`Unknown account type "${row.type}" on account ${row.account_id}`);
    }
    const debitCents = parseCents(row.debit_cents);
    const creditCents = parseCents(row.credit_cents);

    if (row.type === 'Revenue') {
      revenue.push({
        accountId: row.account_id,
        code: row.code,
        name: row.name,
        type: row.type,
        amountCents: creditCents - debitCents,
      });
    } else {
      const statementRow: StatementRow = {
        accountId: row.account_id,
        code: row.code,
        name: row.name,
        type: row.type,
        amountCents: debitCents - creditCents,
      };
      // COGS is not a sixth account type (guardrails rule 12) — the split is
      // by code prefix against the default chart's 5xxx range.
      if (row.code.startsWith('5')) {
        costOfSales.push(statementRow);
      } else {
        operatingExpenses.push(statementRow);
      }
    }
  }

  function section(sectionRows: StatementRow[]): StatementSection {
    return { rows: sectionRows, totalCents: sectionRows.reduce((sum, r) => sum + r.amountCents, 0) };
  }

  const revenueSection = section(revenue);
  const costOfSalesSection = section(costOfSales);
  const operatingExpensesSection = section(operatingExpenses);
  const grossProfitCents = revenueSection.totalCents - costOfSalesSection.totalCents;
  const netIncomeCents = grossProfitCents - operatingExpensesSection.totalCents;

  return {
    from: resolvedFrom,
    to: resolvedTo,
    revenue: revenueSection,
    costOfSales: costOfSalesSection,
    grossProfitCents,
    operatingExpenses: operatingExpensesSection,
    netIncomeCents,
  };
}

interface EarningsSplitRow {
  revenue_prior: string;
  expense_prior: string;
  revenue_current: string;
  expense_current: string;
}

/**
 * Assets = Liabilities + Equity as at `asOf`.
 *
 * Retained earnings is DERIVED, not read from account 3200. LedgerCore posts
 * no year-end closing entry, so no journal ever moves prior-year profit into
 * an equity account — computing it is the only way the sheet can balance.
 * The consequence, stated openly: an organization that manually posts its
 * own closing entry into 3200 will see that amount twice, once in the equity
 * rows and once in retainedEarningsCents. There is no closing-entry feature
 * in LedgerCore for exactly this reason.
 */
export async function balanceSheet(orgId: string, asOf: string | null): Promise<BalanceSheet> {
  const resolvedAsOf = asOf ?? new Date().toISOString().slice(0, 10);
  const { month, day } = await fiscalYearStart(orgId);
  const fiscalYearStartDate = fiscalYearBounds(month, day, resolvedAsOf).startDate;

  const { rows } = await pool.query<StatementRowResult>(
    `SELECT a.id AS account_id, a.code, a.name, a.type,
            COALESCE(SUM(l.base_debit_cents),  0)::text AS debit_cents,
            COALESCE(SUM(l.base_credit_cents), 0)::text AS credit_cents
       FROM accounts a
       JOIN ledger_lines l    ON l.account_id = a.id       AND l.org_id = a.org_id
       JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = a.org_id
      WHERE a.org_id = $1
        AND a.type IN ('Asset', 'Liability', 'Equity')
        AND e.entry_date <= $2::date
      GROUP BY a.id, a.code, a.name, a.type
      ORDER BY a.code ASC`,
    [orgId, resolvedAsOf],
  );

  const assets: StatementRow[] = [];
  const liabilities: StatementRow[] = [];
  const equityRows: StatementRow[] = [];

  for (const row of rows) {
    if (!isAccountType(row.type)) {
      throw new Error(`Unknown account type "${row.type}" on account ${row.account_id}`);
    }
    const debitCents = parseCents(row.debit_cents);
    const creditCents = parseCents(row.credit_cents);

    if (row.type === 'Asset') {
      assets.push({
        accountId: row.account_id,
        code: row.code,
        name: row.name,
        type: row.type,
        amountCents: debitCents - creditCents,
      });
    } else {
      const statementRow: StatementRow = {
        accountId: row.account_id,
        code: row.code,
        name: row.name,
        type: row.type,
        amountCents: creditCents - debitCents,
      };
      if (row.type === 'Liability') {
        liabilities.push(statementRow);
      } else {
        equityRows.push(statementRow);
      }
    }
  }

  function section(sectionRows: StatementRow[]): StatementSection {
    return { rows: sectionRows, totalCents: sectionRows.reduce((sum, r) => sum + r.amountCents, 0) };
  }

  const assetsSection = section(assets);
  const liabilitiesSection = section(liabilities);

  const { rows: splitRows } = await pool.query<EarningsSplitRow>(
    `SELECT
       COALESCE(SUM(CASE WHEN a.type = 'Revenue' THEN l.base_credit_cents - l.base_debit_cents ELSE 0 END)
                FILTER (WHERE e.entry_date < $3::date), 0)::text AS revenue_prior,
       COALESCE(SUM(CASE WHEN a.type = 'Expense' THEN l.base_debit_cents - l.base_credit_cents ELSE 0 END)
                FILTER (WHERE e.entry_date < $3::date), 0)::text AS expense_prior,
       COALESCE(SUM(CASE WHEN a.type = 'Revenue' THEN l.base_credit_cents - l.base_debit_cents ELSE 0 END)
                FILTER (WHERE e.entry_date >= $3::date), 0)::text AS revenue_current,
       COALESCE(SUM(CASE WHEN a.type = 'Expense' THEN l.base_debit_cents - l.base_credit_cents ELSE 0 END)
                FILTER (WHERE e.entry_date >= $3::date), 0)::text AS expense_current
       FROM ledger_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
       JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
      WHERE l.org_id = $1
        AND a.type IN ('Revenue', 'Expense')
        AND e.entry_date <= $2::date`,
    [orgId, resolvedAsOf, fiscalYearStartDate],
  );

  const split = splitRows[0];
  const retainedEarningsCents =
    split === undefined ? 0 : parseCents(split.revenue_prior) - parseCents(split.expense_prior);
  const currentEarningsCents =
    split === undefined ? 0 : parseCents(split.revenue_current) - parseCents(split.expense_current);

  const equity: BalanceSheet['equity'] = {
    rows: equityRows,
    totalCents: equityRows.reduce((sum, r) => sum + r.amountCents, 0) + retainedEarningsCents + currentEarningsCents,
    retainedEarningsCents,
    currentEarningsCents,
  };

  const totalLiabilitiesAndEquityCents = liabilitiesSection.totalCents + equity.totalCents;

  return {
    asOf: resolvedAsOf,
    fiscalYearStartDate,
    assets: assetsSection,
    liabilities: liabilitiesSection,
    equity,
    totalLiabilitiesAndEquityCents,
    // Integer equality, never an epsilon (guardrails rule 3).
    balances: assetsSection.totalCents === totalLiabilitiesAndEquityCents,
  };
}
