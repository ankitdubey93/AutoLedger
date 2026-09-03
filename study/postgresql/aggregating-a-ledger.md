# Aggregating a Ledger: `FILTER`, `generate_series`, and the LEFT JOIN Trap

> A financial dashboard is not a cache of numbers — it's a handful of `SUM`s over the same table, computed fresh on every request, using SQL's `FILTER` clause to get eight different totals from one pass instead of five separate queries.

**Category:** PostgreSQL
**Introduced by:** Phase 3.5 — LedgerCore's dashboard (`dashboardService.dashboardSummary`), which needed position, year-to-date, and month-to-date totals plus a 6-month trend, all from `ledger_lines`
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

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Nine separate scoped queries, one per tile | Simple to read individually | Rejected — nine round trips and nine scans of the same rows for numbers all derivable from one pass |
| `CASE WHEN ... THEN x ELSE 0 END` inside `SUM` | Works, portable to engines without `FILTER` | Rejected — `FILTER` reads as "which rows count for this aggregate," which is literally what's being asked, and avoids the `COUNT(DISTINCT ...)` edge case |
| **One query per report, `FILTER` per aggregate** | All the numbers computed together must share one `FROM`/`JOIN` shape | **Chosen** |
| A cached `account_balances` / `dashboard_summary` table, refreshed on write | Reads become trivial lookups | Rejected — a second source of truth that can drift from `ledger_lines`, the exact class of bug this schema is designed to make impossible |
| Build the 6-month scaffold in TypeScript, then query each month | No SQL gap-filling needed | Rejected — six round trips instead of one, and the "is this month in range" logic ends up duplicated between the app and the database |

---

## Where it lives in this codebase

- `server/src/services/ledger-core/dashboardService.ts` — `loadPosition()` (the nine-`FILTER` scan), `loadTrend()` (the `generate_series` gap-fill), `loadCash()` (a `WITH RECURSIVE` subtree sum, see [recursive-ctes-and-hierarchies.md](recursive-ctes-and-hierarchies.md))
- `server/src/services/ledger-core/reportService.ts` — `trialBalance()`'s `LEFT JOIN` with the `org_id` predicate correctly placed in the `ON` clause, and its own comment stating the no-summary-table rule
- `server/src/__tests__/ledger-core/dashboard.test.ts` — the trend test asserting all 6 months are present, including the 4 with no postings, and the fiscal-year-windowing test asserting `revenue_ytd` respects a non-January start

---

## Gotchas

- **`FILTER` and `CASE` agree on `SUM`, not always on `COUNT(DISTINCT ...)`.** A `CASE ... ELSE NULL END` fed into `COUNT(DISTINCT ...)` can be subtly wrong when the excluded branch's `NULL` collides with a genuine `NULL` in the data; `FILTER` simply never shows the aggregate those rows.
- **A `LEFT JOIN`'s filter condition belongs in `ON`, not `WHERE`, whenever the point of the join is to keep unmatched rows.** Moving it to `WHERE` silently downgrades the join to an `INNER JOIN` — no error, no warning, just a shorter result set.
- **`generate_series` inclusive of both endpoints.** `generate_series($from, $to, INTERVAL '1 month')` returns a row for `$to` itself, which matters when computing "the last 6 months ending in the current month" — get the start-of-range arithmetic wrong by one and you get 5 or 7 rows, not 6.
- **`FILTER` conditions still need every scope predicate.** It's easy to remember the account-type filter and forget that a *join* condition upstream (`org_id`) is what's actually protecting tenancy — `FILTER` restricts an aggregate's rows, it doesn't replace the join's own scoping.
- **This whole approach assumes the table stays cheap to scan.** It is not a permanent architectural guarantee; it's a decision that holds at today's data volume and is explicitly documented as revisitable.

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

**Q: Tell me about a time a predicate's placement changed a query's meaning, not just its performance.**
A: Building the 6-month trend for LedgerCore's dashboard. My first draft put the date-window condition on `WHERE` because that's the reflex — filter the rows you want. It worked for months that had postings, but months with zero activity vanished from the output instead of appearing as a zero row, because the `LEFT JOIN` I'd written to guarantee all six months had its intent undone by a `WHERE` clause running after the join and rejecting the `NULL`-filled rows for months with no match. Moving the exact same condition into the join's `ON` clause fixed it with no other change — same predicate, different clause, structurally different query.

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
