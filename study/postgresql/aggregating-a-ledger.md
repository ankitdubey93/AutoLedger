# Aggregating a Ledger: `FILTER`, `generate_series`, and the LEFT JOIN Trap

> A financial dashboard is not a cache of numbers — it's a handful of `SUM`s over the same table, computed fresh on every request, using SQL's `FILTER` clause to get eight different totals from one pass instead of five separate queries.

**Category:** PostgreSQL
**Introduced by:** Phase 3.5 — LedgerCore's dashboard (`dashboardService.dashboardSummary`), which needed position, year-to-date, and month-to-date totals plus a 6-month trend, all from `ledger_lines`. Extended in Phase 3.6 — the journal register's `journalService.listEntries`, which filters the same table by date range, account, source, and description text. Extended again in Phase 3.9 — `paymentService.allocatedCentsSubquery` (a correlated scalar subquery reused by `invoiceService`/`billService`) and `dashboardService.loadDocumentCounts` (`FILTER` aggregates over a `UNION ALL` of two tables). Extended again in Phase 4 — `reportService.profitAndLoss`/`balanceSheet`, live financial statements with derived retained earnings.
**Verified against:** PostgreSQL 16

---

## Mechanism

### `FILTER` is a per-aggregate `WHERE`, not a `CASE` in disguise

The naive way to get "revenue this year" and "revenue this month" from one query is a `CASE` expression inside `SUM`:

```sql
SUM(CASE WHEN a.type = 'Revenue' AND e.entry_date >= $2 THEN l.base_credit_cents ELSE 0 END)
```

The `FILTER` clause (SQL:2003, PostgreSQL since 9.4) says the same thing more directly:

```sql
SUM(l.base_credit_cents) FILTER (WHERE a.type = 'Revenue' AND e.entry_date >= $2)
```

They compute the same result, but they are not the same operation. `CASE` folds the condition into the *value* being summed — a false branch contributes an explicit `0`, still touching a shared internal state. `FILTER` restricts which *rows* reach the aggregate at all; a row that fails the filter is invisible to that aggregate, not merely zeroed. For `SUM`, `COUNT`, and `AVG` the numeric answer is identical either way, but the difference stops being cosmetic in three places:

1. **`COUNT(DISTINCT x) FILTER (WHERE ...)` has no `CASE` equivalent that behaves the same** — you cannot cleanly express "count distinct values, but only from rows matching this condition" by zeroing values inside a `CASE`, because `CASE ... ELSE NULL END` inside `COUNT(DISTINCT ...)` still lets a real `NULL` collide with the synthetic one from excluded rows.
2. **Readability at the query-plan level.** `EXPLAIN` shows `FILTER` as a distinct node property on the aggregate, which is one honest place to look; a `CASE`-based query buries the same intent inside an expression tree the planner (and the next engineer) has to unpack.
3. **It composes cleanly with multiple independent conditions on one column set**, which is exactly the dashboard's shape: nine numbers, each a `SUM` over the *same* nine-column projection, filtered by a different combination of account type and date.

`dashboardService.dashboardSummary`'s position query pulls nine aggregates — assets, liabilities, equity, revenue/expense at three different date horizons, and an entry count — from **one scan** of `ledger_lines JOIN journal_entries JOIN accounts`:

```sql
SELECT
  SUM(l.base_debit_cents  - l.base_credit_cents) FILTER (WHERE a.type = 'Asset')     AS assets,
  SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Liability') AS liabilities,
  SUM(l.base_credit_cents - l.base_debit_cents)  FILTER (WHERE a.type = 'Revenue' AND e.entry_date >= $2) AS revenue_ytd,
  COUNT(DISTINCT e.id) FILTER (WHERE e.entry_date >= $2) AS entry_count_ytd
  -- ... five more, same shape
FROM ledger_lines l
JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
WHERE l.org_id = $1 AND e.entry_date <= $4;
```

The alternative — nine separate `SELECT ... WHERE type = 'X' AND entry_date >= 'Y'` queries — would mean nine round trips to the database and nine independent scans of the same rows, for numbers that are all derivable from one pass.

### Why the `org_id` predicate belongs in the JOIN, not the WHERE — on a LEFT JOIN specifically

`reportService.trialBalance` and `dashboardService`'s trend query both `LEFT JOIN` so that a row with no matching activity still appears — a trial balance needs every account listed even at zero, and a trend needs every month listed even with no postings. That requirement is exactly what makes predicate placement load-bearing:

```sql
-- Correct: a month with no postings still appears, at zero.
FROM months m
LEFT JOIN journal_entries e ON e.org_id = $1
                            AND e.entry_date >= m.month_start
                            AND e.entry_date <  (m.month_start + INTERVAL '1 month')::date
LEFT JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = e.org_id
```

versus the same predicate moved to `WHERE`:

```sql
-- Wrong: silently becomes an INNER join.
FROM months m
LEFT JOIN journal_entries e ON e.entry_date >= m.month_start
                            AND e.entry_date <  (m.month_start + INTERVAL '1 month')::date
LEFT JOIN ledger_lines l    ON l.journal_entry_id = e.id
WHERE e.org_id = $1
```

A `LEFT JOIN`'s `ON` clause decides which rows from the *right* table match each row of the *left* table — a row on the left with no match still survives, with every right-hand column `NULL`. `WHERE` runs **after** that join has already produced its result set, filtering the combined rows. `e.org_id = $1` in `WHERE` throws away exactly the rows the `LEFT JOIN` exists to keep: a month with genuinely no entries produces `e.org_id = NULL`, and `NULL = $1` is `NULL` (not `true`), which `WHERE` treats as "exclude." The join has quietly become an `INNER JOIN` — every month with zero activity vanishes from the result instead of appearing at zero, which is the one behavior the whole query was written to guarantee.

The same reasoning is why `l.org_id = a.org_id` sits inside the `LEFT JOIN`'s `ON` in the trial balance and dashboard position queries: it is a *join condition*, restricting which lines are considered a match for a given account, not a filter on the final row set.

### `generate_series` as the gap-filler

`dashboardService`'s 6-month trend needs a fixed number of rows — six — regardless of how many months actually had postings. `generate_series` over a date range, joined against, produces exactly that scaffold:

```sql
WITH months AS (
  SELECT generate_series($2::date, $3::date, INTERVAL '1 month')::date AS month_start
)
SELECT to_char(m.month_start, 'YYYY-MM') AS month, ...
  FROM months m
  LEFT JOIN journal_entries e ON e.org_id = $1
                              AND e.entry_date >= m.month_start
                              AND e.entry_date <  (m.month_start + INTERVAL '1 month')::date
  ...
 GROUP BY m.month_start
 ORDER BY m.month_start ASC;
```

`generate_series(start, stop, step)` with `date`/`interval` arguments is a **set-returning function** — it produces one row per step, inclusive of both ends, and behaves like any other table in `FROM`. Six calendar months in, `months` genuinely has six rows before any join runs; the subsequent `LEFT JOIN`s can only ever add columns to those six rows or leave them `NULL`, never remove one. That inversion — build the shape of the answer first, then left-join the data onto it — is the general pattern for "a fixed calendar grid with sparse data," not specific to trends: the same idiom generates a full list of days, weeks, or fiscal periods with no gaps.

### Why there is no summary table, and what that actually costs

Every report in LedgerCore — trial balance, dashboard — computes its numbers from `ledger_lines` on every single request. `docs/schema.md` and `docs/ledger-core.md` both state this as a rule, not an oversight, and the reasoning is the same one behind rejecting `DECIMAL` for money: a cached `account_balances` column is a second representation of a fact already recorded elsewhere, and it can drift from the rows it's supposed to summarize the first time an `UPDATE` to the cache is missed, ordered wrong, or partially applied. Reconciling a drifted cache against its source of truth is exactly the manual bookkeeping work this system exists to remove.

The honest trade-off: this only stays free because the table stays small. A `SUM` with a `FILTER` over a few thousand rows, backed by the indexes on `(org_id, account_id)` and `(org_id, entry_date)`, runs in single-digit milliseconds. At real scale — millions of lines per organization — this exact query would need either a materialized view with an explicit, monitored refresh, or a rollup table maintained transactionally alongside every insert (which reintroduces the drift risk, now paid for deliberately rather than by accident). Nothing here forecloses that path; it just refuses to pay its complexity cost before the data volume that would justify it.

### Composing an optional filter predicate safely

The journal register (`GET /ledger-core/journals`) accepts up to five independent, all-optional filters — `from`, `to`, `accountId`, `sourceType`, `q` — and needs a `totalCount` that agrees with the page it returns. `journalService.buildFilters` builds one `{ where, values }` pair and hands it to **both** the `count(*)` query and the paginated `SELECT`:

```ts
function buildFilters(orgId: string, options: ListEntriesOptions) {
  const clauses = ['e.org_id = $1'];
  const values: unknown[] = [orgId];

  function add(fragment: (placeholder: string) => string, value: unknown): void {
    values.push(value);
    clauses.push(fragment(`$${values.length}`));
  }

  if (options.from !== null) add((p) => `e.entry_date >= ${p}::date`, options.from);
  // ...
  return { where: clauses.join(' AND '), values };
}
```

Two queries built from two independently-assembled predicate strings is a live bug waiting to happen: the moment one gains a clause the other doesn't, `totalCount` and the returned page silently disagree — a register that says "47 results" while rendering 12, or a `totalPages` that leaves the last page unreachable. Sharing one builder makes that class of bug structurally impossible rather than a discipline to remember.

**Why `EXISTS`, not a `JOIN` plus `DISTINCT`, for "has a line on this account":**

```sql
-- Chosen: EXISTS
WHERE e.org_id = $1
  AND EXISTS (SELECT 1 FROM ledger_lines l
              WHERE l.journal_entry_id = e.id AND l.org_id = e.org_id AND l.account_id = $2)

-- Rejected: JOIN + DISTINCT
SELECT DISTINCT e.* FROM journal_entries e
JOIN ledger_lines l ON l.journal_entry_id = e.id AND l.org_id = e.org_id
WHERE e.org_id = $1 AND l.account_id = $2
```

An entry with two lines on the same account (a rare but legal double-entry shape) makes the `JOIN` version return that entry's row twice, which `DISTINCT` then has to de-duplicate — an extra sort/hash step over the whole result. `EXISTS` is a **semi-join**: the planner stops at the first matching line per entry and never materializes a second copy of `e`, so there's nothing to de-duplicate and no `DISTINCT` needed anywhere in the query, including the `count(*)`.

**Why `ILIKE '%' || $n || '%'` and not `ILIKE '%$n%'`:** the second form is not a bug that leaks the search term — it's not parameterized at all. `'%$n%'` inside a single-quoted SQL string literal is just the four characters `$`, `n`, wrapped in `%` wildcards; the driver never substitutes anything into the *middle* of a string literal, only where a bare `$n` placeholder stands alone. Building the wildcard by concatenating three separate SQL string operands — `'%'`, the parameter, `'%'` — keeps the parameter itself a genuine bound value, never text spliced into the query.

### A correlated scalar subquery, chosen over a JOIN + GROUP BY, because the outer query is already 1 row per document

Phase 3.9 needed "how much of this invoice has been paid" available as a column on every invoice/bill read — see [derived-vs-stored-state.md](../architecture/derived-vs-stored-state.md) for why it's computed rather than stored. The question here is narrower: given that it's computed, why a correlated subquery and not a join?

```sql
COALESCE((SELECT SUM(pa.amount_cents)
            FROM payment_allocations pa
            JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
           WHERE pa.org_id = i.org_id
             AND pa.invoice_id = i.id
             AND p.status = 'POSTED'), 0)::text AS allocated_cents
```

`INVOICE_SELECT` (the query this is embedded in) already produces exactly one row per invoice — it joins `customers` and `users`, both to-one relationships from an invoice's perspective. Joining `payment_allocations` directly into that same query would introduce a to-*many* relationship (an invoice can have arbitrarily many allocations), which multiplies every invoice row by its allocation count: a twice-paid invoice becomes two output rows, both carrying duplicated `customer_name`, `created_by_name`, and every other column from the 1:1 side. Fixing that back up needs `GROUP BY` on every non-aggregated column plus wrapping the money column in `SUM`, which is a bigger rewrite than the fact "I need one more number per row" should justify.

A **correlated subquery** — a subquery whose `WHERE` clause references a column from the outer query (`pa.invoice_id = i.id`) — sidesteps the multiplication entirely. Conceptually, Postgres evaluates it once per outer row, each time scoped to just that row's `id`; the result is a single scalar, so it composes as an ordinary output column with no `GROUP BY` needed anywhere in the outer query. In practice, the planner is free to implement this more efficiently than a literal per-row loop — for an equality-correlated subquery like this one, it typically becomes an index lookup per outer row rather than a nested-loop re-scan, provided the right index exists (here, `idx_allocations_invoice`/`idx_allocations_bill`, both on the FK column the correlation filters on).

The trade-off is real and stated plainly, not hidden: this is `O(rows × log(allocations))`, not a single flat scan the way the dashboard's `FILTER` aggregates are. It's the right shape when the outer query's grain must stay 1:1 and the extra value is a single number per row — wrong when you actually want the allocation-level detail (in which case a join is exactly what you want, rows and all, which is what `agingService`'s open-documents CTE does instead).

### `FILTER` aggregates over a `UNION ALL` of two structurally different tables

The dashboard's document-count tile needs six numbers — draft/awaiting-review counts and sums, split across `invoices` and `bills`, two tables with different columns and no shared parent. `loadDocumentCounts` gets all six from one query by first collapsing both tables to a common shape, then filtering:

```sql
SELECT
  COUNT(*) FILTER (WHERE kind = 'INVOICE' AND status = 'DRAFT')::text AS invoice_draft_count,
  COALESCE(SUM(total_cents) FILTER (WHERE kind = 'BILL' AND status = 'AWAITING_APPROVAL'), 0)::text AS bill_review_cents,
  -- ... four more, same shape
FROM (
  SELECT 'INVOICE' AS kind, status, total_cents FROM invoices WHERE org_id = $1
  UNION ALL
  SELECT 'BILL'    AS kind, status, total_cents FROM bills    WHERE org_id = $1
) d
```

`UNION ALL` (not `UNION`) stacks the two `SELECT`s' rows without a duplicate-elimination pass — appropriate here because an invoice row and a bill row can never be genuine duplicates of each other (different tables, different id spaces), so paying for `UNION`'s implicit `DISTINCT` would buy nothing. The synthetic `kind` column is what makes the six downstream `FILTER` clauses able to tell which table a row came from once both are flattened into one result set — without it, "count DRAFT rows" would conflate draft invoices and draft bills into one number.

**The `org_id = $1` predicate appears in *both* arms of the `UNION ALL`, independently** — not once, hoisted to an outer `WHERE`, because there is no single outer `WHERE` that could reach inside a `UNION ALL`'s member queries. Each `SELECT` is scoped on its own, which means each is individually a candidate for a tenant-data leak if the predicate is ever dropped from just one arm — a one-line omission in the second `SELECT` would let one organization's document counts include another's bills while its invoice counts stayed correctly scoped, a partial leak that's easy to miss in review precisely because half the query still looks right.

**Why not a `JOIN`?** These aren't related tables — an invoice and a bill share no foreign key, no common parent, nothing a `JOIN`'s `ON` clause could meaningfully express. `UNION ALL` is the operator for "these rows belong in the same result set" when the relationship between two sources is "conceptually the same kind of thing" (both are financial documents with a status and a total), not "these rows are associated with each other."

**Why `FILTER` here does more work than in the position query:** the dashboard's earlier nine-`FILTER` query (see above) filters on conditions over columns that already exist per row (`a.type`, `e.entry_date`). Here, `kind` is a column that exists *only because the query manufactured it* in the `UNION ALL`'s projection — `FILTER` isn't just selecting rows by pre-existing properties, it's discriminating between two conceptually different source tables that a single aggregation pass has deliberately flattened together.

### Deriving a P&L and a balance sheet from raw lines — sign convention, and splitting one scan into two windows

`reportService.trialBalance` reports every postable account's raw `debitCents`/`creditCents` and lets the caller decide what they mean. `profitAndLoss` and `balanceSheet` can't stay that neutral — "Revenue − Expenses" and "Assets = Liabilities + Equity" are only true once each account's balance is expressed on its own *normal side*:

```ts
// Asset, Expense: a debit increases the balance.
amountCents = debitCents - creditCents;

// Liability, Equity, Revenue: a credit increases the balance.
amountCents = creditCents - debitCents;
```

Reporting a raw `debitCents - creditCents` for a Revenue account would show a healthy sales month as a large negative number — technically the correct sign for a credit-normal account read the asset way, but exactly backwards from what "revenue" means to a reader. The five-line `if (row.type === 'Revenue') ... else ...` branch in `profitAndLoss` (and the equivalent one in `balanceSheet`) exists entirely to make that flip once, in one place, rather than asking every consumer of the raw columns to remember which of the five account types they're looking at.

**Why `INNER JOIN`, not `trialBalance`'s `LEFT JOIN`:** the trial balance's `LEFT JOIN` exists so a *never-used* account still appears at zero — that's the whole point of a trial balance, proving the full chart nets to zero. A P&L or balance sheet is asking a narrower question — "what happened in this account during this window" — and an account with zero activity contributes a zero-value row that's pure noise, not rigor. `profitAndLoss`/`balanceSheet` both `JOIN` (inner) `ledger_lines`/`journal_entries` onto `accounts`, so only accounts with at least one matching line survive the join at all; there's no `l.id IS NULL` guard to write because there's no unmatched-row case to guard against.

**Splitting revenue and expense into a prior-year/current-year pair with `FILTER`, not two queries:** `balanceSheet` needs both a cumulative "retained earnings" figure (every prior fiscal year's net income, all at once) and the current fiscal year's net income up to `asOf` — the same underlying rows, split by which side of one date they fall on. One query gets both halves from a single scan:

```sql
SELECT
  COALESCE(SUM(CASE WHEN a.type = 'Revenue' THEN l.base_credit_cents - l.base_debit_cents ELSE 0 END)
           FILTER (WHERE e.entry_date < $3::date), 0)::text AS revenue_prior,
  -- expense_prior, revenue_current, expense_current: same shape, flipped condition
  ...
  FROM ledger_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
  JOIN accounts a        ON a.id = l.account_id       AND a.org_id = l.org_id
 WHERE l.org_id = $1 AND a.type IN ('Revenue', 'Expense') AND e.entry_date <= $2::date
```

This nests two independent decisions inside one aggregate: the `CASE` picks *which account type* a row contributes to (Revenue rows count positively toward one number, Expense rows toward another — an ordinary value-level branch, unlike `FILTER`'s row-level one), and the `FILTER` on the same aggregate call picks *which time window* the row falls into. Four numbers, one pass over the join, rather than two separate queries with a `< $3` and a `>= $3` condition each — the same reasoning `dashboardService`'s nine-`FILTER` position query already established, applied to a 2×2 grid (type × window) instead of a flat list of independent totals.

**Retained earnings is computed, never read from account `3200`.** LedgerCore posts no year-end closing journal entry — there is no automated process that debits every revenue/expense account to zero and credits the difference into Retained Earnings, the way a real closing entry would. So `3200`'s balance (if anything was ever posted to it directly) and the balance sheet's `retainedEarningsCents` are two different numbers answering the same question by two different means: one is whatever was manually posted, the other is `SUM(revenue) - SUM(expense)` over every entry before the current fiscal year, computed fresh on every request — the same no-summary-table discipline the trial balance and dashboard already follow, just applied to a number that in a system with a real closing process would otherwise live in a stored account balance. The trade-off is stated plainly in the code: an organization that *does* post its own closing entry into `3200` will see that year's earnings counted twice — once as a posted equity row, once folded into the derived figure — because the schema has no way to tell "a manual entry that happens to look like a closing entry" from any other equity posting.

**Why `ORDER BY e.entry_date DESC, e.created_at DESC, e.id DESC` and not just the first two:** `LIMIT`/`OFFSET` pagination is only stable if the `ORDER BY` produces a total order — every row strictly before every row on the next page, with no ties. `entry_date` and `created_at` (millisecond resolution) can genuinely tie for two entries posted in the same request burst; without a final tiebreaker on a column guaranteed unique (the primary key), Postgres is free to return those tied rows in either order on different executions of the same query, which means a row can appear on two pages, or on neither, as a caller pages through. Any unique column works as the last term — `id` is simply the one every table already has.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Nine separate scoped queries, one per tile | Simple to read individually | Rejected — nine round trips and nine scans of the same rows for numbers all derivable from one pass |
| `CASE WHEN ... THEN x ELSE 0 END` inside `SUM` | Works, portable to engines without `FILTER` | Rejected — `FILTER` reads as "which rows count for this aggregate," which is literally what's being asked, and avoids the `COUNT(DISTINCT ...)` edge case |
| **One query per report, `FILTER` per aggregate** | All the numbers computed together must share one `FROM`/`JOIN` shape | **Chosen** |
| A cached `account_balances` / `dashboard_summary` table, refreshed on write | Reads become trivial lookups | Rejected — a second source of truth that can drift from `ledger_lines`, the exact class of bug this schema is designed to make impossible |
| Build the 6-month scaffold in TypeScript, then query each month | No SQL gap-filling needed | Rejected — six round trips instead of one, and the "is this month in range" logic ends up duplicated between the app and the database |
| Two separately-built `WHERE` strings, one for `count(*)`, one for the page | Each query reads slightly simpler in isolation | Rejected — the two are free to drift apart, which shows up as a `totalCount` that disagrees with the rows actually returned |
| `JOIN ledger_lines` + `DISTINCT` for the account filter | Familiar shape | Rejected — an entry with two lines on the filtered account is returned twice by the join, requiring a de-dup sort `EXISTS` never needs |
| `OFFSET/LIMIT` with `ORDER BY entry_date DESC, created_at DESC` only | One fewer column in the sort | Rejected — two entries can tie on both columns, and an untied final term is what makes paging past them stable |
| `JOIN payment_allocations` + `GROUP BY` for a document's paid amount | Familiar shape, one query style throughout | Rejected — the outer query is 1:1 per document; a to-many join fans it out and forces every other column into a `GROUP BY` or an aggregate it doesn't need |
| **Correlated scalar subquery for the paid amount** | `O(rows × log(allocations))`, needs the FK indexed | **Chosen** — composes as an ordinary column, no `GROUP BY` anywhere in the outer query |
| Two separate queries (invoice counts, bill counts), summed in application code | Simple, no `UNION ALL` | Rejected — two round trips for numbers from what is conceptually one "documents" concept, and the app has to remember to add them correctly |
| **`FILTER` over `UNION ALL` of `invoices`/`bills`** | Both arms must independently repeat every scope predicate | **Chosen** — one round trip, one scan pass over both tables |
| A stored `retained_earnings` column, updated by a year-end closing job | Balance sheet reads become trivial | Rejected — no closing-entry feature exists to keep it correct, and a stored figure with no write path that maintains it is worse than no figure at all |
| Two queries for the prior/current earnings split (`< $3` and `>= $3` separately) | Each query reads simpler alone | Rejected — same rows scanned twice for numbers that one `FILTER`-per-window pass already produces together |
| `trialBalance`'s `LEFT JOIN` reused for P&L/balance sheet | One join shape everywhere | Rejected — a P&L/balance sheet's question ("what had activity") is answered by which accounts the `INNER JOIN` keeps; the trial balance's question ("does the full chart net to zero") needs the `LEFT JOIN`'s unmatched rows instead |

---

## Where it lives in this codebase

- `server/src/services/ledger-core/dashboardService.ts` — `loadPosition()` (the nine-`FILTER` scan), `loadTrend()` (the `generate_series` gap-fill), `loadCash()` (a `WITH RECURSIVE` subtree sum, see [recursive-ctes-and-hierarchies.md](recursive-ctes-and-hierarchies.md))
- `server/src/services/ledger-core/reportService.ts` — `trialBalance()`'s `LEFT JOIN` with the `org_id` predicate correctly placed in the `ON` clause, and its own comment stating the no-summary-table rule
- `server/src/services/ledger-core/journalService.ts` — `buildFilters()` (the shared predicate builder), `listEntries()` (the count query and the page query, both fed from it), the `EXISTS` account filter, and the `e.id DESC` pagination tiebreaker
- `server/src/__tests__/ledger-core/dashboard.test.ts` — the trend test asserting all 6 months are present, including the 4 with no postings, and the fiscal-year-windowing test asserting `revenue_ytd` respects a non-January start
- `server/src/__tests__/ledger-core/journals.test.ts` — `describe('register filters')`, including the `totalCount reflects the filter, not the table` case and the same-date pagination-stability case
- `server/src/services/ledger-core/paymentService.ts` — `allocatedCentsSubquery(alias, column)`, the correlated scalar subquery shared by `invoiceService`/`billService`/`agingService`
- `server/src/services/ledger-core/dashboardService.ts` — `loadDocumentCounts()`, the `FILTER`-over-`UNION ALL` query behind the dashboard's draft/awaiting-review tiles
- `server/src/__tests__/ledger-core/dashboard.test.ts` — `describe('AR/AP blocks')`, including the cross-tenant case proving org B's documents never appear in org A's counts
- `server/src/services/ledger-core/reportService.ts` — `profitAndLoss()` (the type-aware sign flip, the 5xxx-prefix COGS split, the `INNER JOIN`) and `balanceSheet()` (the same sign flip for Asset/Liability/Equity, plus the prior/current earnings `FILTER` pair)
- `server/src/__tests__/ledger-core/statements.test.ts` — the fixture proving `Assets = Liabilities + Equity` by integer equality, the `information_schema` assertion that no summary table exists, and the cross-check that P&L net income for a fiscal year equals the balance sheet's current-period earnings at that year's end

---

## Gotchas

- **`FILTER` and `CASE` agree on `SUM`, not always on `COUNT(DISTINCT ...)`.** A `CASE ... ELSE NULL END` fed into `COUNT(DISTINCT ...)` can be subtly wrong when the excluded branch's `NULL` collides with a genuine `NULL` in the data; `FILTER` simply never shows the aggregate those rows.
- **A `LEFT JOIN`'s filter condition belongs in `ON`, not `WHERE`, whenever the point of the join is to keep unmatched rows.** Moving it to `WHERE` silently downgrades the join to an `INNER JOIN` — no error, no warning, just a shorter result set.
- **`generate_series` inclusive of both endpoints.** `generate_series($from, $to, INTERVAL '1 month')` returns a row for `$to` itself, which matters when computing "the last 6 months ending in the current month" — get the start-of-range arithmetic wrong by one and you get 5 or 7 rows, not 6.
- **`FILTER` conditions still need every scope predicate.** It's easy to remember the account-type filter and forget that a *join* condition upstream (`org_id`) is what's actually protecting tenancy — `FILTER` restricts an aggregate's rows, it doesn't replace the join's own scoping.
- **This whole approach assumes the table stays cheap to scan.** It is not a permanent architectural guarantee; it's a decision that holds at today's data volume and is explicitly documented as revisitable.
- **A count query and a page query built from two different predicate strings will eventually disagree.** The fix is structural — one shared builder, called twice — not a discipline to remember on every future filter added.
- **`LIMIT/OFFSET` needs a total order, not just "mostly sorted."** Any `ORDER BY` that can tie on two rows needs a unique column as its last term, or pagination silently drops or duplicates rows on the tied boundary.
- **A wildcard built by string concatenation (`'%' || $n || '%'`) is still fully parameterized.** Don't confuse "the SQL text contains `%` characters" with "the value is unparameterized" — the placeholder is still a single bound value, just concatenated with literal wildcard characters at the database, not in application code.
- **A correlated subquery only stays cheap with the right index.** `allocatedCentsSubquery` correlates on `pa.invoice_id = i.id` (or `bill_id`); without `idx_allocations_invoice`/`idx_allocations_bill`, the planner falls back to a sequential scan of `payment_allocations` per outer row — fine at small data volumes, a real cost at large ones.
- **`UNION ALL`'s member queries each need their own complete scope predicate.** There is no outer `WHERE` that reaches inside a `UNION ALL` — `org_id = $1` has to be repeated, correctly, in every arm. A predicate present in one arm and missing from another is a partial tenant leak that's easy to miss because half the query's output still looks correctly scoped.
- **`UNION ALL` vs `UNION`: the choice is about semantics, not just performance.** `UNION` would also happen to work here (an invoice row and a bill row can never collide), but reaching for `UNION ALL` by default when duplicates are structurally impossible avoids paying for a de-duplication pass — sort or hash — that could never find anything to remove.
- **A raw `debitCents - creditCents` is only meaningful for Asset/Expense accounts.** Reporting it unflipped for a Revenue, Liability, or Equity account shows a healthy balance as a large negative number — correct arithmetic, wrong sign for the account's normal side. Every statement query needs the type-aware branch, not just the trial balance.
- **Retained earnings computed from `SUM(revenue) - SUM(expense)` and a manually-posted closing entry into the retained-earnings account are two answers to the same question that will disagree the moment both exist.** There's no way for the schema to distinguish "an ordinary equity posting" from "a hand-rolled closing entry," so an organization that posts its own closing entry sees that year's earnings counted twice on the balance sheet.
- **`INNER JOIN` vs `LEFT JOIN` is a decision about what the report claims, not a performance knob.** Switching a trial balance's `LEFT JOIN` to `INNER JOIN` would silently drop every account with zero activity from a report whose entire point is proving the *full* chart nets to zero.

---

## Interview Q&A

**Q: What does `FILTER (WHERE ...)` actually do differently from a `CASE` expression inside an aggregate?**
A: `CASE` changes the *value* a row contributes to the aggregate — the false branch typically substitutes zero or `NULL`, but the row is still part of what the aggregate function sees. `FILTER` changes which *rows* are visible to that aggregate at all; a row failing the filter simply isn't there for that particular `SUM` or `COUNT`. For most aggregates the numeric result is identical either way, but they diverge for `COUNT(DISTINCT ...)`, where a `CASE`'s synthetic `NULL` for excluded rows can interact with a real `NULL` in the data in ways that produce a wrong distinct count. `FILTER` also reads more directly — it says "which rows count for this number," which is literally the question being asked.

**Q: Why compute nine different totals in one query instead of nine simpler queries?**
A: All nine numbers come from the same underlying join of `ledger_lines`, `journal_entries`, and `accounts` — the only thing that differs between them is which rows should be included, which is exactly what a `FILTER` clause expresses per-aggregate. Running nine separate queries would mean nine round trips to the database and nine full scans of largely the same rows, for numbers that a single pass can produce together. It only makes sense to split them out if they genuinely came from unrelated tables or needed fundamentally different row sets.

**Q: You LEFT JOIN so that empty months still show up in a trend chart. What breaks if you put the date filter in WHERE instead of the JOIN's ON clause?**
A: The join silently becomes an inner join. A `LEFT JOIN`'s `ON` clause decides what counts as a match while still keeping every row from the left-hand side, even with `NULL`s on the right for no match. `WHERE` runs after that join has already happened, so filtering on a right-hand column there discards exactly the rows with no match — because `NULL = anything` isn't true, so `WHERE` excludes them. The visible symptom is a trend chart that quietly drops every month with no activity instead of showing it at zero, and there's no error to point at — the query just returns fewer rows than it should.

**Q: How does `generate_series` help you produce a fixed-size result when the underlying data is sparse?**
A: You build the shape of the answer first — one row per month, week, or whatever unit — using `generate_series` as a genuine table-valued source in the `FROM` clause, and then `LEFT JOIN` the real data onto that scaffold. Because the scaffold is established before any join runs, the join can only add matching data or leave a row `NULL` — it can never remove a scaffold row. That inverts the usual approach of "query the data, then wonder about the gaps": you guarantee the shape structurally instead of patching gaps in application code afterward.

**Q: Why not maintain a summary table so these reports are instant lookups?**
A: Because it's a second copy of a fact that already lives in `ledger_lines`, and a cache that can drift from its source is the exact bug class this schema is built to eliminate — the same reasoning behind never storing money as `DECIMAL` with an epsilon comparison. At today's data volume, a `SUM` with a `FILTER` over a few thousand rows, backed by the right indexes, runs in single-digit milliseconds, so there's no performance problem to solve yet. If the row count grew by orders of magnitude, the honest next step is a materialized view with an explicit, monitored refresh — not a column updated by hand on every write, which reintroduces the drift risk deliberately rather than by accident.

**Q: You've built a paginated, filterable list endpoint with a `totalCount`. What's the most common way that number ends up wrong, and how do you prevent it structurally?**
A: The most common cause is that the count query and the page query are built from two independently-maintained `WHERE` clauses — someone adds a filter to one and forgets the other, or the two drift apart over several small edits. The number then reports the whole table (or a different subset) while the rows shown reflect the filters actually applied. The structural fix is to build one predicate — the SQL fragment and its parameter array — once, in one function, and pass that same object to both queries. That makes "the two disagree" a state the code cannot represent, rather than a discipline to remember on every future filter.

**Q: Why use `EXISTS` instead of a `JOIN` when filtering "entries that have a line on this account"?**
A: `EXISTS` is a semi-join — for each candidate entry, Postgres stops as soon as it finds one matching line and never produces extra rows for additional matches. A plain `JOIN` against `ledger_lines` produces one output row per matching line, so an entry with two lines on the filtered account would appear twice, forcing a `DISTINCT` (and its sort or hash) to collapse the duplicates back down. `EXISTS` needs no `DISTINCT` anywhere in the query, including the `count(*)`, because it can never produce the duplicate in the first place.

**Q: Is `ILIKE '%' || $1 || '%'` vulnerable to SQL injection the way string-interpolating a value into a query is?**
A: No — `$1` there is still a genuine bound parameter; the driver sends it to Postgres separately from the query text and it's never re-parsed as SQL. The `||` operators are ordinary SQL string concatenation, evaluated *inside* the database, combining the literal `%` characters with whatever value the parameter holds. The unsafe version would be building the whole `LIKE` pattern as a JavaScript template string and substituting that into the query text — `` `ILIKE '%${term}%'` `` — which is exactly the interpolation rule 4 exists to forbid.

**Q: Two rows share the same `entry_date` and the same `created_at` down to the millisecond. What actually happens if your `ORDER BY` doesn't include a unique tiebreaker, and why does it only bite under pagination?**
A: Without a unique final term, Postgres is free to return those two tied rows in either relative order, and isn't obligated to return the same order on repeated executions of an otherwise-identical query — the standard makes no such guarantee, and the planner may pick a different physical access path run to run. A single unpaginated `SELECT` rarely surfaces this — a human skimming a full result set doesn't usually notice two rows swapped. Under `LIMIT/OFFSET` it becomes visible: if the tied pair straddles a page boundary, one execution's page 1 might include row A and exclude row B, and the next request for page 2 — a fresh query — might reorder them so that B appears on both pages while A appears on neither.

**Q: Tell me about a time a predicate's placement changed a query's meaning, not just its performance.**
A: Building the 6-month trend for LedgerCore's dashboard. My first draft put the date-window condition on `WHERE` because that's the reflex — filter the rows you want. It worked for months that had postings, but months with zero activity vanished from the output instead of appearing as a zero row, because the `LEFT JOIN` I'd written to guarantee all six months had its intent undone by a `WHERE` clause running after the join and rejecting the `NULL`-filled rows for months with no match. Moving the exact same condition into the join's `ON` clause fixed it with no other change — same predicate, different clause, structurally different query.

**Q: You needed a per-invoice "amount paid" figure — why a correlated subquery instead of joining `payment_allocations` in?**
A: Because the outer query is already producing exactly one row per invoice — it joins customers and users, both to-one relationships. `payment_allocations` is to-many: an invoice can have several allocations across several payments. Joining that directly in would multiply the invoice row by its allocation count and force a `GROUP BY` over every other selected column just to collapse it back down. A correlated subquery — scoped to the current invoice's id in its own `WHERE` — returns one scalar per outer row instead, so it composes as an ordinary column with no `GROUP BY` needed anywhere. The cost is that it's evaluated per row rather than in one flat scan, which is fine as long as the correlating column is indexed, which it is.

**Q: How did you get draft/review counts from two unrelated tables — invoices and bills — in one query?**
A: `UNION ALL` first, to stack both tables' relevant columns into one result set with a synthetic `kind` column saying which table each row came from, then `FILTER` clauses on top of that to split the counts and sums back apart by `kind` and `status`. `UNION ALL` rather than `UNION` because an invoice row and a bill row can never be duplicates of each other, so there's nothing for `UNION`'s de-duplication pass to do except cost time. The one thing that has to be gotten right is that the tenant scope predicate — `org_id = $1` — has to be repeated in *both* arms of the `UNION ALL` independently; there's no single outer `WHERE` that reaches inside it, so a predicate present in one arm and missing from the other is a real, easy-to-miss tenant leak.

**Q: Your trial balance reports raw debits and credits; your P&L and balance sheet report a single signed `amountCents` per account. Why the difference?**
A: A trial balance's entire job is to be a neutral proof that the ledger balances — it reports exactly what's posted, debit and credit columns side by side, so a reader can verify `SUM(debits) = SUM(credits)` without any interpretation layered on. A P&L or balance sheet is making a specific accounting claim — "revenue is up," "assets exceed liabilities" — and that claim only reads correctly once each account's balance is expressed on its own normal side: `debit - credit` for Asset/Expense, `credit - debit` for Liability/Equity/Revenue. Skip that flip and a strong revenue month reports as a large negative number, technically consistent but meaningless to anyone reading it as "how much did we earn."

**Q: Why does the P&L use an `INNER JOIN` when the trial balance next to it uses a `LEFT JOIN`?**
A: They're answering different questions. The trial balance has to list every postable account, including ones with zero activity, because proving the *whole chart* nets to zero is the point — a `LEFT JOIN` keeps unmatched accounts at zero for exactly that reason. A P&L is asking "what had activity in this window," and an account with no lines contributes nothing meaningful to that answer — an `INNER JOIN` just doesn't produce a row for it, which is correct here rather than an oversight.

**Q: How do you get "earnings before this fiscal year" and "earnings this fiscal year" without running two separate queries?**
A: One query, two independent decisions layered on the same aggregate call. A `CASE` inside the `SUM` picks which account type (Revenue vs. Expense) a row contributes to — an ordinary value-level branch. A `FILTER (WHERE e.entry_date < $3)` on that same `SUM` picks which time window the row falls into, without touching which rows are visible to the *other* three sums in the same query. Four numbers — revenue-prior, expense-prior, revenue-current, expense-current — come out of one scan of the join, instead of running essentially the same query twice with the date comparison flipped.

**Q: Where does your balance sheet's "retained earnings" figure actually come from?**
A: It's computed on every request, never stored — `SUM(revenue) - SUM(expense)` over every journal entry dated before the current fiscal year's start, using the org's configured fiscal-year boundary. There's no year-end closing entry anywhere in the system that would move that figure into an actual equity account, so a stored `retained_earnings` column would have no process keeping it correct. Computing it fresh means it's automatically consistent with whatever's actually posted, at the cost that if an organization ever manually posts something that looks like a closing entry into the retained-earnings account, that year's profit gets counted twice — once as a posted row, once folded into the derived figure. That's a stated, known gap, not a hidden one.

---

## Follow-ups they'll dig into

- *"How would you paginate a report like this if the account list got huge?"* Keyset pagination on `accounts.code` rather than `OFFSET`, since `code` is already the natural sort order and an offset scan degrades linearly with page depth.
- *"What does `EXPLAIN ANALYZE` show for a query with several `FILTER` clauses?"* One `Aggregate` node with multiple `Filter:` annotations, still a single scan of the underlying join — worth actually running to see the planner confirm there's no per-aggregate re-scan.
- *"When would a materialized view be the right call here?"* Once the scan itself becomes the bottleneck rather than network round trips — a materialized view trades a stale-until-refreshed answer for a fast one, and needs an explicit decision about acceptable staleness, which a live aggregate never has to make.
- *"What's the difference between `generate_series` with a `date`/`interval` step and one with integers?"* Same function, different type resolution — the interval form is what makes calendar arithmetic (crossing month and year boundaries) correct for free, rather than something you'd compute by hand with modular arithmetic on integers.

---

## See also

- [recursive-ctes-and-hierarchies.md](recursive-ctes-and-hierarchies.md) — the other query in this dashboard, and the same "scope every term" discipline applied to a different join shape
- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the invariant these numbers rest on: an aggregate over an always-balanced ledger is exactly why `isBalanced` can be an integer equality check
- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md) — why every one of these sums is over `BIGINT` cents, never `DECIMAL`
- [../architecture/derived-vs-stored-state.md](../architecture/derived-vs-stored-state.md) — why the correlated subquery's result is never cached back onto the invoice/bill row
- [subledger-reconciliation-and-aging.md](subledger-reconciliation-and-aging.md) — the same subquery reused in a report that also cross-checks its total against the general ledger
- [exclusion-constraints-and-gist.md](exclusion-constraints-and-gist.md) — fiscal periods, the other half of Phase 4, and why "no posting into a closed period" is a database trigger rather than another aggregate query
