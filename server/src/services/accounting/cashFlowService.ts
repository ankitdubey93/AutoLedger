import { pool } from '../../db/connect.js';
import { parseCents } from '../../utils/money.js';
import { deriveCashFlowCategory } from '../../utils/cashFlowCategory.js';
import {
  isAccountType,
  isBankAccountKind,
  isCashFlowCategory,
  type CashFlowCashAccount,
  type CashFlowRow,
  type CashFlowSection,
  type CashFlowStatement,
} from '../../types/accounting.js';
import { profitAndLoss, resolveControlAccounts } from './reportService.js';

/**
 * The cash flow statement, indirect method (Phase 45).
 *
 * Net income, then the cash effect of every balance-sheet account that is not
 * itself cash, grouped OPERATING / INVESTING / FINANCING. By double entry every
 * posted entry balances, and every postable account is either P&L (inside net
 * income) or balance-sheet (classified here), so the net change equals the
 * movement of the CASH accounts by construction. The invariant at the end turns
 * a classification bug into a loud error instead of a wrong statement.
 *
 * Base-currency columns only, like the other statements.
 */

interface CashFlowQueryRow {
  id: string;
  code: string;
  name: string;
  type: string;
  bank_account_kind: string | null;
  cash_flow_category: string | null;
  codes: string[];
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
}

function emptySection(): CashFlowSection {
  return { rows: [], totalCents: 0 };
}

export async function cashFlowStatement(
  orgId: string,
  from: string | null,
  to: string | null,
): Promise<CashFlowStatement> {
  // Resolves the default window and raises the 422 exactly as the P&L does.
  const pnl = await profitAndLoss(orgId, from, to);
  const netIncomeCents = pnl.netIncomeCents;
  const { cashAccountId } = await resolveControlAccounts(orgId);

  const { rows } = await pool.query<CashFlowQueryRow>(
    `WITH RECURSIVE ancestry AS (
       SELECT a.id AS account_id, a.parent_id, ARRAY[]::text[] AS codes
         FROM accounts a WHERE a.org_id = $1
       UNION ALL
       SELECT an.account_id, p.parent_id, an.codes || p.code
         FROM ancestry an JOIN accounts p ON p.id = an.parent_id AND p.org_id = $1
     ), paths AS (
       SELECT account_id, codes FROM ancestry WHERE parent_id IS NULL
     )
     SELECT a.id, a.code, a.name, a.type, a.bank_account_kind, a.cash_flow_category, p.codes,
            COALESCE(SUM(l.base_debit_cents)  FILTER (WHERE e.entry_date <  $2::date), 0)::text AS opening_debit,
            COALESCE(SUM(l.base_credit_cents) FILTER (WHERE e.entry_date <  $2::date), 0)::text AS opening_credit,
            COALESCE(SUM(l.base_debit_cents)  FILTER (WHERE e.entry_date >= $2::date), 0)::text AS period_debit,
            COALESCE(SUM(l.base_credit_cents) FILTER (WHERE e.entry_date >= $2::date), 0)::text AS period_credit
       FROM accounts a
       JOIN paths p ON p.account_id = a.id
       LEFT JOIN ledger_lines l    ON l.account_id = a.id AND l.org_id = a.org_id
       LEFT JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = a.org_id AND e.entry_date <= $3::date
      WHERE a.org_id = $1 AND a.is_postable AND a.type IN ('Asset', 'Liability', 'Equity')
        AND (l.id IS NULL OR e.id IS NOT NULL)
      GROUP BY a.id, a.code, a.name, a.type, a.bank_account_kind, a.cash_flow_category, p.codes
      ORDER BY a.code`,
    [orgId, pnl.from, pnl.to],
  );

  const operating = emptySection();
  const investing = emptySection();
  const financing = emptySection();
  const cashAccounts: CashFlowCashAccount[] = [];

  for (const row of rows) {
    if (!isAccountType(row.type)) {
      throw new Error(`Unknown account type "${row.type}" on account ${row.id}`);
    }
    if (row.bank_account_kind !== null && !isBankAccountKind(row.bank_account_kind)) {
      throw new Error(`Unknown bank account kind "${row.bank_account_kind}" on account ${row.id}`);
    }
    if (row.cash_flow_category !== null && !isCashFlowCategory(row.cash_flow_category)) {
      throw new Error(`Unknown cash flow category "${row.cash_flow_category}" on account ${row.id}`);
    }

    const isCashControlAccount = row.id === cashAccountId;
    const category = deriveCashFlowCategory({
      type: row.type,
      bankAccountKind: row.bank_account_kind,
      isCashControlAccount,
      ancestorCodes: row.codes,
      override: row.cash_flow_category,
    });
    if (category === null) continue; // unreachable: the query only selects balance-sheet types

    const openingDebit = parseCents(row.opening_debit);
    const openingCredit = parseCents(row.opening_credit);
    const periodDebit = parseCents(row.period_debit);
    const periodCredit = parseCents(row.period_credit);

    if (category === 'CASH') {
      const openingCents = openingDebit - openingCredit;
      const closingCents = openingCents + periodDebit - periodCredit;
      if (openingCents !== 0 || closingCents !== 0 || isCashControlAccount) {
        cashAccounts.push({
          accountId: row.id,
          code: row.code,
          name: row.name,
          openingCents,
          closingCents,
        });
      }
      continue;
    }

    const amountCents = periodCredit - periodDebit;
    if (amountCents === 0) continue;

    const cashRow: CashFlowRow = {
      accountId: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      category,
      categorySource: row.cash_flow_category !== null ? 'OVERRIDE' : 'DERIVED',
      amountCents,
    };
    const section = category === 'OPERATING' ? operating : category === 'INVESTING' ? investing : financing;
    section.rows.push(cashRow);
    section.totalCents += amountCents;
  }

  operating.totalCents += netIncomeCents;

  const netChangeCents = operating.totalCents + investing.totalCents + financing.totalCents;
  let openingCashCents = 0;
  let closingCashCents = 0;
  for (const account of cashAccounts) {
    openingCashCents += account.openingCents;
    closingCashCents += account.closingCents;
  }

  // Integer equality (rule 3). By double entry this cannot fail unless an
  // account was misclassified or a line is missing from both net income and
  // the classified balance-sheet accounts.
  if (netChangeCents !== closingCashCents - openingCashCents) {
    throw new Error(
      `Cash flow does not reconcile: ${String(netChangeCents)} vs ${String(closingCashCents - openingCashCents)}`,
    );
  }

  return {
    from: pnl.from,
    to: pnl.to,
    netIncomeCents,
    operating,
    investing,
    financing,
    netChangeCents,
    openingCashCents,
    closingCashCents,
    cashAccounts,
  };
}
