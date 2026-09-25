import type { PoolClient } from 'pg';
import { pool } from '../../db/connect.js';
import { ApiError } from '../../utils/apiError.js';
import { parseCents } from '../../utils/money.js';
import * as accountService from './accountService.js';
import {
  isAccountType,
  isDebitBalanceType,
  type AccountBalance,
  type AccountLedger,
  type AccountLedgerRow,
} from '../../types/accounting.js';
import type { InventoryValuationLine } from '../../types/inventory.js';

/** Phase 35a — read-only helpers below accept either `pool` or a transaction `client`. */
type Queryable = Pick<PoolClient, 'query'>;

/**
 * One postable account's ledger — opening balance, every posted line with a
 * running balance, period totals, closing balance — and the whole chart's
 * balances, own and rolled up.
 *
 * Every query is scoped by `org_id` (guardrails rule 1). Balances are
 * type-aware, matching `reportService.trialBalance`'s `netBalanceCents`:
 * debit-positive for Asset and Expense, credit-positive otherwise.
 */

export interface AccountLedgerOptions {
  page: number;
  limit: number;
  from: string | null;
  to: string | null;
}

interface OpeningRow {
  debit_cents: string;
  credit_cents: string;
}

interface PeriodRow {
  total_count: string;
  debit_cents: string;
  credit_cents: string;
}

interface LineRow {
  line_id: string;
  entry_id: string;
  entry_date: string;
  description: string | null;
  source_type: string;
  source_id: string | null;
  reverses_entry_id: string | null;
  created_at: Date;
  debit_cents: string;
  credit_cents: string;
  running_signed_cents: string;
}

export async function accountLedger(
  orgId: string,
  accountId: string,
  options: AccountLedgerOptions,
): Promise<AccountLedger> {
  const account = await accountService.getAccountById(orgId, accountId);

  if (!account.isPostable) {
    throw new ApiError(
      422,
      `Account ${account.code} is a header account and has no ledger of its own`,
    );
  }

  const direction = isDebitBalanceType(account.type) ? 1 : -1;

  // Opening balance: everything strictly before `from`. Skipped entirely when
  // `from` is null — the opening balance is then 0 by definition.
  let openingBalanceCents = 0;
  if (options.from !== null) {
    const { rows } = await pool.query<OpeningRow>(
      `SELECT COALESCE(SUM(l.base_debit_cents), 0)::text  AS debit_cents,
              COALESCE(SUM(l.base_credit_cents), 0)::text AS credit_cents
         FROM ledger_lines l
         JOIN journal_entries e
           ON e.id = l.journal_entry_id
          AND e.org_id = l.org_id
        WHERE l.org_id = $1
          AND l.account_id = $2
          AND e.entry_date < $3::date`,
      [orgId, accountId, options.from],
    );
    const row = rows[0];
    openingBalanceCents =
      direction * (parseCents(row?.debit_cents ?? '0') - parseCents(row?.credit_cents ?? '0'));
  }

  // Period totals and count, over the whole filtered window before pagination.
  const { rows: periodRows } = await pool.query<PeriodRow>(
    `SELECT count(*)::text                              AS total_count,
            COALESCE(SUM(l.base_debit_cents), 0)::text  AS debit_cents,
            COALESCE(SUM(l.base_credit_cents), 0)::text AS credit_cents
       FROM ledger_lines l
       JOIN journal_entries e
         ON e.id = l.journal_entry_id
        AND e.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.account_id = $2
        AND ($3::date IS NULL OR e.entry_date >= $3::date)
        AND ($4::date IS NULL OR e.entry_date <= $4::date)`,
    [orgId, accountId, options.from, options.to],
  );
  const periodRow = periodRows[0];
  const totalCount = Number(periodRow?.total_count ?? '0');
  const periodDebitCents = parseCents(periodRow?.debit_cents ?? '0');
  const periodCreditCents = parseCents(periodRow?.credit_cents ?? '0');
  const closingBalanceCents =
    openingBalanceCents + direction * (periodDebitCents - periodCreditCents);

  // The page, with a running balance computed as a window function over the
  // whole filtered set — evaluated before LIMIT/OFFSET, which is exactly what
  // lets page 2's running balance continue page 1's rather than restarting.
  // The explicit ROWS frame (not the default RANGE) is required: RANGE
  // includes every peer row sharing the ORDER BY value, which would give two
  // lines posted on the same date the same running balance. `l.id` is the
  // tiebreaker that makes the ORDER BY (and therefore the frame) unambiguous.
  const offset = (options.page - 1) * options.limit;
  const { rows: lineRows } = await pool.query<LineRow>(
    `SELECT l.id                AS line_id,
            e.id                AS entry_id,
            e.entry_date,
            e.description,
            e.source_type,
            e.source_id,
            e.reverses_entry_id,
            l.created_at,
            l.base_debit_cents::text  AS debit_cents,
            l.base_credit_cents::text AS credit_cents,
            (SUM(l.base_debit_cents - l.base_credit_cents)
               OVER (ORDER BY e.entry_date ASC, l.created_at ASC, l.id ASC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::text AS running_signed_cents
       FROM ledger_lines l
       JOIN journal_entries e
         ON e.id = l.journal_entry_id
        AND e.org_id = l.org_id
      WHERE l.org_id = $1
        AND l.account_id = $2
        AND ($3::date IS NULL OR e.entry_date >= $3::date)
        AND ($4::date IS NULL OR e.entry_date <= $4::date)
      ORDER BY e.entry_date ASC, l.created_at ASC, l.id ASC
      LIMIT $5 OFFSET $6`,
    [orgId, accountId, options.from, options.to, options.limit, offset],
  );

  // Counterparts: one further query for the page's entries only, never one
  // query per row.
  const entryIds = [...new Set(lineRows.map((r) => r.entry_id))];
  const counterpartsByEntry = new Map<string, string[]>();
  if (entryIds.length > 0) {
    const { rows: counterpartRows } = await pool.query<{ journal_entry_id: string; label: string }>(
      `SELECT cl.journal_entry_id,
              a.code || ' ' || a.name AS label
         FROM ledger_lines cl
         JOIN accounts a
           ON a.id = cl.account_id
          AND a.org_id = cl.org_id
        WHERE cl.org_id = $1
          AND cl.journal_entry_id = ANY($2::uuid[])
          AND cl.account_id <> $3
        ORDER BY a.code ASC`,
      [orgId, entryIds, accountId],
    );
    for (const row of counterpartRows) {
      const list = counterpartsByEntry.get(row.journal_entry_id) ?? [];
      if (!list.includes(row.label)) list.push(row.label);
      counterpartsByEntry.set(row.journal_entry_id, list);
    }
  }

  const rows: AccountLedgerRow[] = lineRows.map((row) => ({
    lineId: row.line_id,
    entryId: row.entry_id,
    entryDate: row.entry_date,
    description: row.description,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reversesEntryId: row.reverses_entry_id,
    createdAt: row.created_at.toISOString(),
    debitCents: parseCents(row.debit_cents),
    creditCents: parseCents(row.credit_cents),
    runningBalanceCents: openingBalanceCents + direction * parseCents(row.running_signed_cents),
    counterparts: counterpartsByEntry.get(row.entry_id) ?? [],
  }));

  return {
    account: { id: account.id, code: account.code, name: account.name, type: account.type },
    from: options.from,
    to: options.to,
    openingBalanceCents,
    periodDebitCents,
    periodCreditCents,
    closingBalanceCents,
    rows,
    totalCount,
  };
}

interface BalanceRow {
  account_id: string;
  type: string;
  own_debit_cents: string;
  own_credit_cents: string;
  rollup_debit_cents: string;
  rollup_credit_cents: string;
}

/**
 * Own and subtree-rollup balance for every account in the org, including
 * headers and inactive accounts — retiring a child must not make its history
 * vanish from its parent's rollup.
 *
 * `subtree` walks *down* from every account to its descendants, the mirror of
 * `accountService.wouldCreateCycle`'s walk *up* to ancestors. Its anchor emits
 * `(id, id)` so every account is its own first descendant, which is what makes
 * a leaf's rollup equal its own balance. The recursive term carries
 * `c.org_id = $1` in addition to the anchor's — dropping it would let the walk
 * cross into another tenant's tree, the same discipline `wouldCreateCycle`
 * uses (guardrails rule 1). No depth guard is needed: `accounts` cannot cycle,
 * because `wouldCreateCycle` refuses the write that would create one.
 */
export async function accountBalances(
  orgId: string,
  asOf: string | null,
): Promise<AccountBalance[]> {
  const { rows } = await pool.query<BalanceRow>(
    `WITH RECURSIVE own AS (
       -- The date filter lives inside this subquery, on the pre-joined line/
       -- entry pair, rather than as a WHERE clause layered over an outer LEFT
       -- JOIN: filtering with "l.id IS NULL OR e.id IS NOT NULL" after the
       -- fact drops an account entirely once every one of its lines falls
       -- outside the window, instead of leaving it at zero — there is no
       -- longer an "l.id IS NULL" row to keep it. Pre-filtering here and then
       -- LEFT JOINing the (possibly empty) result onto the unconditional
       -- account list keeps every account, postings or not.
       SELECT a.id,
              COALESCE(SUM(fl.base_debit_cents),  0) AS debit_cents,
              COALESCE(SUM(fl.base_credit_cents), 0) AS credit_cents
         FROM accounts a
         LEFT JOIN (
           SELECT l.account_id, l.org_id, l.base_debit_cents, l.base_credit_cents
             FROM ledger_lines l
             JOIN journal_entries e
               ON e.id = l.journal_entry_id
              AND e.org_id = l.org_id
            WHERE l.org_id = $1
              AND ($2::date IS NULL OR e.entry_date <= $2::date)
         ) fl
                ON fl.account_id = a.id
               AND fl.org_id = a.org_id
        WHERE a.org_id = $1
        GROUP BY a.id
     ),
     subtree AS (
       SELECT a.id AS ancestor_id, a.id AS descendant_id
         FROM accounts a
        WHERE a.org_id = $1
       UNION ALL
       SELECT s.ancestor_id, c.id
         FROM subtree s
         JOIN accounts c
           ON c.parent_id = s.descendant_id
          AND c.org_id = $1
     )
     SELECT a.id                      AS account_id,
            a.type,
            o.debit_cents::text       AS own_debit_cents,
            o.credit_cents::text      AS own_credit_cents,
            SUM(d.debit_cents)::text  AS rollup_debit_cents,
            SUM(d.credit_cents)::text AS rollup_credit_cents
       FROM accounts a
       JOIN own o     ON o.id = a.id
       JOIN subtree s ON s.ancestor_id = a.id
       JOIN own d     ON d.id = s.descendant_id
      WHERE a.org_id = $1
      GROUP BY a.id, a.code, a.type, o.debit_cents, o.credit_cents
      ORDER BY a.code ASC`,
    [orgId, asOf],
  );

  return rows.map((row) => {
    if (!isAccountType(row.type)) {
      throw new Error(`Unknown account type "${row.type}" on account ${row.account_id}`);
    }
    const direction = isDebitBalanceType(row.type) ? 1 : -1;

    return {
      accountId: row.account_id,
      ownBalanceCents:
        direction * (parseCents(row.own_debit_cents) - parseCents(row.own_credit_cents)),
      rollupBalanceCents:
        direction * (parseCents(row.rollup_debit_cents) - parseCents(row.rollup_credit_cents)),
    };
  });
}

// ---------------------------------------------------- Phase 35a — GL reconciliation reads

/**
 * Net debit-positive base-currency balance of each given account, as of a
 * date (or all-time when `asOf` is null). Every id in `accountIds` is present
 * in the returned map, at 0 when the account has no lines in the window —
 * pre-filtered in a subquery, like `accountBalances` above, so an account
 * absent from `ledger_lines` entirely is never dropped by the join.
 */
export async function balancesForAccountsOnClient(
  client: Queryable,
  orgId: string,
  accountIds: string[],
  asOf: string | null,
): Promise<Map<string, { code: string; name: string; netDebitCents: number }>> {
  const result = new Map<string, { code: string; name: string; netDebitCents: number }>();
  if (accountIds.length === 0) return result;

  const { rows } = await client.query<{
    account_id: string;
    code: string;
    name: string;
    net_debit_cents: string;
  }>(
    `SELECT a.id AS account_id, a.code, a.name,
            COALESCE(SUM(fl.base_debit_cents - fl.base_credit_cents), 0)::text AS net_debit_cents
       FROM accounts a
       LEFT JOIN (
         SELECT l.account_id, l.org_id, l.base_debit_cents, l.base_credit_cents
           FROM ledger_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
          WHERE l.org_id = $1 AND ($3::date IS NULL OR e.entry_date <= $3::date)
       ) fl ON fl.account_id = a.id AND fl.org_id = a.org_id
      WHERE a.org_id = $1 AND a.id = ANY($2::uuid[])
      GROUP BY a.id, a.code, a.name`,
    [orgId, accountIds, asOf],
  );
  for (const row of rows) {
    result.set(row.account_id, { code: row.code, name: row.name, netDebitCents: parseCents(row.net_debit_cents) });
  }
  return result;
}

/**
 * Lines on these accounts whose entry's EFFECTIVE source (a reversal's
 * original entry's source, followed through `reverses_entry_id`) is not one
 * of `subledgerSourceTypes` — the lines a stock reconciliation cannot explain
 * from `bill`/`invoice`/`stock` postings. Newest first, capped at `limit` per
 * account with a window function (not a per-account query loop).
 */
export async function listNonSubledgerLinesOnClient(
  client: Queryable,
  orgId: string,
  accountIds: string[],
  asOf: string | null,
  subledgerSourceTypes: string[],
  limit: number,
): Promise<Map<string, InventoryValuationLine[]>> {
  const result = new Map<string, InventoryValuationLine[]>();
  if (accountIds.length === 0) return result;

  const { rows } = await client.query<{
    account_id: string;
    journal_entry_id: string;
    entry_date: string;
    description: string | null;
    effective_source_type: string;
    net_debit_cents: string;
  }>(
    `WITH lines AS (
       SELECT l.account_id, e.id AS journal_entry_id, e.entry_date, e.description,
              COALESCE(o.source_type, e.source_type) AS effective_source_type,
              SUM(l.base_debit_cents - l.base_credit_cents) AS net_debit_cents
         FROM ledger_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
         LEFT JOIN journal_entries o ON o.id = e.reverses_entry_id AND o.org_id = e.org_id
        WHERE l.org_id = $1 AND l.account_id = ANY($2::uuid[])
          AND ($3::date IS NULL OR e.entry_date <= $3::date)
        GROUP BY l.account_id, e.id, e.entry_date, e.description, COALESCE(o.source_type, e.source_type)
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY entry_date DESC, journal_entry_id DESC) AS rn
         FROM lines
        WHERE NOT (effective_source_type = ANY($4::text[]))
     )
     SELECT account_id, journal_entry_id, entry_date, description, effective_source_type, net_debit_cents::text
       FROM ranked
      WHERE rn <= $5
      ORDER BY account_id, entry_date DESC, journal_entry_id DESC`,
    [orgId, accountIds, asOf, subledgerSourceTypes, limit],
  );
  for (const row of rows) {
    const list = result.get(row.account_id) ?? [];
    list.push({
      journalEntryId: row.journal_entry_id,
      entryDate: row.entry_date,
      description: row.description,
      sourceType: row.effective_source_type,
      netDebitCents: parseCents(row.net_debit_cents),
    });
    result.set(row.account_id, list);
  }
  return result;
}
