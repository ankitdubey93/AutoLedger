import { pool } from '../../db/connect.js';
import { parseCents } from '../../utils/money.js';
import { isAccountType, type TrialBalance, type TrialBalanceRow } from '../../types/ledger-core.js';

/**
 * Financial statements, computed from raw `ledger_lines` on every request.
 *
 * **There is no summary table and none will be added.** A cached
 * `account_balances` column is a second source of truth that drifts from the
 * lines it summarises, and reconciling the two is the manual work this system
 * exists to remove. Postgres aggregates a few thousand rows in single-digit
 * milliseconds; when that stops being true the answer is a materialized view
 * with an explicit refresh, not a column updated by hand.
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
