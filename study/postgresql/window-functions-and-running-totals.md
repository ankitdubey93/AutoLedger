# Window Functions and Running Totals

> A running balance isn't computed by looping over rows in application code — it's a `SUM(...) OVER (ORDER BY ...)` evaluated by the database in the same pass as the rest of the query, which is what lets it survive pagination without restarting.

**Category:** PostgreSQL
**Introduced by:** Phase 3.6 — LedgerCore's account ledger (`accountLedgerService.accountLedger`), the standard "click an account, see its transaction history with a running balance" view every accounting application (Xero, QuickBooks Online) offers.
**Verified against:** PostgreSQL 16.14

---

## Mechanism

### Where a window function sits in a query's logical order of operations

SQL is not evaluated in the order it's written. A `SELECT` conceptually executes roughly as:

```
FROM/JOIN → WHERE → GROUP BY → HAVING → window functions → SELECT list → DISTINCT → ORDER BY → LIMIT/OFFSET
```

Window functions run **after** `WHERE`/`GROUP BY`/`HAVING` have already reduced the row set down to what will be returned, but **before** `ORDER BY` and `LIMIT`/`OFFSET` are applied to that result. This ordering is the entire reason a windowed running balance can be paginated correctly at all: by the time `LIMIT`/`OFFSET` slice out "page 2," every row's running-balance value has already been computed **over the full filtered set**, not just the 50 rows that happen to survive the slice. A running total computed by any mechanism that runs after pagination — accumulating in application code over just the rows a `LIMIT` returned, for instance — has no way to know what came before page 2 without a second query.

`accountLedgerService.accountLedger`'s core query does exactly this in one `SELECT`:

```sql
SELECT l.id, e.entry_date, l.base_debit_cents, l.base_credit_cents,
       (SUM(l.base_debit_cents - l.base_credit_cents)
          OVER (ORDER BY e.entry_date ASC, l.created_at ASC, l.id ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::text AS running_signed_cents
  FROM ledger_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
 WHERE l.org_id = $1 AND l.account_id = $2
   AND ($3::date IS NULL OR e.entry_date >= $3::date)
   AND ($4::date IS NULL OR e.entry_date <= $4::date)
 ORDER BY e.entry_date ASC, l.created_at ASC, l.id ASC
 LIMIT $5 OFFSET $6
```

The `WHERE` clause narrows to one account's lines within a date window — that's the "filtered set" the window sees. The `SUM(...) OVER (...)` then runs across every row that survived `WHERE`, computing each row's cumulative sum *before* `LIMIT $5 OFFSET $6` throws away every row outside the requested page. Page 2's first row's `running_signed_cents` already reflects everything on page 1 — the database did that arithmetic, not the application.

### `OVER (ORDER BY ...)`: a moving frame, not a `GROUP BY` collapse

`GROUP BY` collapses many rows into one per group — you lose the individual rows, keeping only the aggregate. A window function does the opposite: every input row survives in the output, each annotated with an aggregate computed over some *window* of rows related to it. `OVER (ORDER BY col)` with no explicit frame defaults to "every row from the start of the partition up to (and including, by default) the current row" — which is precisely the definition of a running total. Omit the `OVER` clause entirely and `SUM()` becomes an ordinary aggregate, collapsing the whole result to one row; add it and the same function becomes a per-row annotation instead.

### `ROWS` versus `RANGE`, and why the default framing is a live bug for this query

A window function's frame — which rows, relative to the current one, get summed — has two framing modes:

- **`ROWS BETWEEN ... AND CURRENT ROW`**: physical row count. "The current row and everything before it, by position in the sort order," full stop, regardless of whether any values tie.
- **`RANGE BETWEEN ... AND CURRENT ROW`** (the **default** when a frame clause is omitted): logical peer grouping. Every row that is a *peer* of the current row under the `ORDER BY` — meaning every row that compares equal on the `ORDER BY` columns — is included in the frame for **all** of those peer rows alike, not incrementally one at a time.

Concretely: two lines posted on the same `entry_date` with the same `created_at` (a real possibility — two entries created in the same request burst, or in this schema's `threePurchases`-style fixture data written by a single batched insert) are *peers* under `ORDER BY e.entry_date, l.created_at, l.id`... except `l.id` is a unique tiebreaker, so they are never true peers here specifically **because** the `ORDER BY` was written to end in a unique column. Had the `ORDER BY` stopped at `entry_date, created_at` and the default `RANGE` frame been left in place, both tied rows would receive the **same** running balance — the balance *after* both of them, assigned to each — rather than one balance for the first and a different, larger one for the second. `accountLedgerService` avoids this two ways at once, and either alone would have sufficed: it specifies `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` explicitly (physical position, peers or not), and its `ORDER BY` already ends in `l.id`, a primary key, so no two rows can ever be true peers regardless of framing mode. Belt and suspenders — the explicit `ROWS` frame documents the intent even though the tiebreaker alone would have produced the same numeric answer under `RANGE` too, since a unique `ORDER BY` means every "peer group" has exactly one member.

### Why the tiebreaker matters independently of the frame

Even setting the `RANGE`/`ROWS` question aside, `LIMIT`/`OFFSET` pagination is only well-defined over a **total order** — every row strictly before or after every other row, no ties. `ORDER BY e.entry_date ASC, l.created_at ASC` alone can leave two rows genuinely tied (down to `created_at`'s stored precision), and Postgres makes no guarantee about which tied row it returns first, or that it returns them in the same relative order on a repeated execution of the same query. Under pagination that ambiguity becomes visible: a tied pair straddling a page boundary can appear on neither page, or on both, depending on which arbitrary order Postgres happens to pick that time. `l.id ASC` as the final `ORDER BY` term closes that gap, and it does double duty — the same column that stabilizes pagination is also what stabilizes the window frame.

### Why this runs on every request, computed fresh, rather than being stored

Consistent with every other report in this codebase (see [aggregating-a-ledger.md](aggregating-a-ledger.md)), there is no `running_balance` column anywhere in `ledger_lines`. Storing one would require updating every later row's balance whenever an earlier row changes — impossible here anyway, since posted rows are immutable by trigger, but the deeper point is that a stored running balance is a derived value with exactly the drift risk this schema is built to eliminate. The window function recomputes it from the append-only source of truth on every request; at the row counts a single account accumulates, that recomputation is a single indexed scan plus an in-memory pass, not a performance concern.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Accumulate the running balance in TypeScript over the fetched page | Simple, no SQL feature needed | Rejected — breaks under pagination: page 2 has no way to know page 1's ending balance without a second query for exactly that number |
| A correlated subquery per row (`SELECT SUM(...) WHERE entry_date <= outer.entry_date`) | Standard SQL, no window syntax | Rejected — O(n²): a fresh aggregate scan for every one of n rows, versus one pass for a window function |
| A stored `running_balance` column on `ledger_lines`, maintained on insert | Reads become a plain column lookup | Rejected — a second, derivable representation of a fact the append-only lines already encode; the same class of drift risk that rules out a summary table anywhere else in this schema |
| **`SUM(...) OVER (ORDER BY ... ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`, computed fresh per request** | Requires understanding window-function framing and pagination interaction | **Chosen** |
| Leave the default `RANGE` frame (omit an explicit frame clause) | Fewer words in the query | Rejected — peer rows under the default frame would share one running balance instead of each getting their own, the exact bug two same-timestamp lines would trigger |

---

## Where it lives in this codebase

- `server/src/services/ledger-core/accountLedgerService.ts` — `accountLedger()`'s line-page query, the explicit `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` frame, and the `l.id ASC` tiebreaker shared between the `ORDER BY` and the window's implicit ordering
- `server/src/__tests__/ledger-core/accountLedger.test.ts` — `'the running balance accumulates'` (the basic case) and `'the running balance continues across pages'` (the case that actually exercises why the window runs before `LIMIT`)
- `client/src/Pages/ledger-core/AccountLedgerPage.tsx` — renders the server-computed `runningBalanceCents` per row; there is no client-side accumulation anywhere

---

## Gotchas

- **Omitting a window frame doesn't mean "no frame" — it means the default `RANGE` frame**, which groups by logical peers under the `ORDER BY`, not physical row position. This is the single most common source of "why do two of my rows have the same running total" bugs.
- **A frame needs the same tiebreaker discipline as `LIMIT`/`OFFSET` pagination does**, and for the same underlying reason: an `ORDER BY` that can tie doesn't define a total order, and both the window's frame and the page slice depend on one.
- **Window functions run before `LIMIT`/`OFFSET`, not after.** It's tempting to think of pagination as "compute the answer, then take a slice" — for a windowed running total, the slicing happens strictly after the per-row computation, in the same query, which is the mechanism that makes cross-page continuity work at all.
- **A window function cannot appear in a `WHERE` clause** (logical order of operations again — `WHERE` runs before window functions do), which is why filtering "rows where the running balance exceeds X" needs an outer query wrapping the windowed `SELECT`, or a `QUALIFY`-equivalent pattern (Postgres has no `QUALIFY`; a subquery or CTE is the idiom).
- **This still costs a real scan.** A window function is not free — Postgres still has to sort (or use an already-sorted index) and pass over every row in the filtered set to compute the running values, even though only one page is returned. At the row counts a single account's ledger accumulates this is invisible; it would not stay invisible at a materially larger scale, the same honest caveat every report in this codebase carries.

---

## Interview Q&A

**Q: What's the difference between a window function and `GROUP BY`?**
A: `GROUP BY` collapses multiple input rows into one output row per group — the individual rows are gone, only the aggregate survives. A window function keeps every input row in the output and annotates each one with an aggregate computed over some window of related rows (via `OVER (...)`), so you get both the detail and the aggregate together. `SUM(x)` with a `GROUP BY` gives you one total per group; `SUM(x) OVER (ORDER BY ...)` gives you a per-row running total, with every original row still present.

**Q: You're building a running balance in a paginated list — `LIMIT 50 OFFSET 100` for page 3. Where does the window function's computation happen relative to that `LIMIT`?**
A: Before it. SQL's logical order of operations puts window functions after `WHERE`/`GROUP BY`/`HAVING` but before `ORDER BY` and `LIMIT`/`OFFSET`. So the running total for every row in the full filtered result is computed first, and only afterward does `LIMIT`/`OFFSET` slice out the 50 rows for page 3. That ordering is exactly why the running balance on page 3 correctly continues from page 2's — the database already summed everything before page 3's slice, even though only page 3's rows are returned.

**Q: What would go wrong if you instead computed the running balance in your application code, row by row, as you rendered each page?**
A: It would be correct for page 1, where the running total naturally starts at zero, but every subsequent page would restart from zero too, because the application never sees the rows on earlier pages within that request — each page is a separate query result with no memory of the last row's balance from the previous page. You'd need to separately fetch (or cache) the balance as of the end of the prior page, which is either an extra query per page or a stateful cache to keep synchronized. Doing the arithmetic in the same query the pagination itself runs against sidesteps the whole problem.

**Q: Two rows tie exactly on your window's `ORDER BY` columns. What actually happens to their running total, and why?**
A: It depends on the frame mode. The default frame, `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, groups by *logical peers* — every row that ties on the `ORDER BY` columns is treated as one peer group, and the running sum jumps to include the whole group at once rather than incrementing row by row within it. So both tied rows would show the identical running total — the value *after* both, not one value for each. `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` instead counts physical row position regardless of ties, so each row gets its own strictly-increasing value, in whatever order Postgres happens to have picked for the tie — which is why you also want a unique tiebreaker in the `ORDER BY` itself, so that "whatever order Postgres happens to pick" isn't ambiguous either.

**Q: Why can't you filter on a window function's result directly in a `WHERE` clause?**
A: Because of the same logical order of operations — `WHERE` is evaluated before window functions run, so at the point `WHERE` executes, the windowed value doesn't exist yet to filter on. You have to compute it first (in the `SELECT` list, or a CTE) and then filter in an outer query or a later clause against that already-materialized value. Some other databases have a `QUALIFY` clause built exactly for this; Postgres doesn't, so the idiom here is a subquery or CTE wrapping the windowed `SELECT`.

**Q: Tell me about a time you had to reason carefully about a window function's frame.**
A: Building LedgerCore's account ledger, which shows a running balance per line. My first pass left the frame clause off, relying on the default. It worked in every manual test I tried by hand, because I was clicking through single entries with distinct timestamps. The bug only showed up once I wrote a fixture with three entries and thought about what happens when two lines share both `entry_date` and `created_at` — which is realistic, not a contrived edge case, since AutoLedger's own test factories can insert several fixture rows in the same batch. Under the default `RANGE` frame those two rows would report the identical running balance instead of two distinct, increasing values. Making the frame explicit (`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`) and adding `l.id` as a final `ORDER BY` tiebreaker fixed it — and I kept both, even though the tiebreaker alone would have been sufficient, because the explicit frame documents the intent for the next person reading the query rather than relying on them knowing the default.

---

## Follow-ups they'll dig into

- *"How would you compute a 7-day moving average instead of an all-time running total?"* Same `OVER (ORDER BY ...)` shape, but a bounded frame — `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW` for a row-count window, or `RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW` for a genuinely date-based window (which needs a `RANGE` frame with an actual interval, not the row-count `ROWS` form).
- *"What other window functions exist besides `SUM`?"* `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()` for positional ranking; `LAG()`/`LEAD()` for reading an adjacent row's value without a self-join; `FIRST_VALUE()`/`LAST_VALUE()` for the frame's boundary values. All share the same `OVER (...)` mechanics described here.
- *"Would `PARTITION BY` change anything for this ledger query?"* Yes — if the ledger ever needed independent running balances per some grouping (say, per fiscal year, so each year restarts from zero) rather than one continuous balance, `PARTITION BY` would reset the window at each partition boundary; this schema deliberately doesn't do that, since a running balance conceptually continues across period boundaries until an explicit close (Phase 4).
- *"How would `EXPLAIN ANALYZE` show this running differently from a plain aggregate query?"* A `WindowAgg` node, typically fed by a `Sort` (unless an index already provides the required order) — worth actually running to see whether the existing `(org_id, account_id)` index on `ledger_lines` avoids a separate sort step for this particular `ORDER BY`.

---

## See also

- [aggregating-a-ledger.md](aggregating-a-ledger.md) — the sibling technique for a snapshot total (`FILTER`), versus this note's per-row running total; also the shared "why does this project have no summary tables" reasoning
- [recursive-ctes-and-hierarchies.md](recursive-ctes-and-hierarchies.md) — the other place a single query replaces what would otherwise be per-row application-code iteration
- `server/src/services/ledger-core/accountLedgerService.ts` — the query this note is written against
