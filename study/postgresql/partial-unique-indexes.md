# Partial Unique Indexes: Uniqueness That Only Applies Sometimes

> `UNIQUE (a, b)` answers "is this pair ever repeated, anywhere in the table?" A partial unique index answers a narrower, often more honest question: "is this pair ever repeated *among rows that matter*?" — and lets every other row be duplicated freely.

**Category:** PostgreSQL
**Introduced by:** Phase 9b — `ux_migration_imports_one_committed_opening`, the constraint that makes a second committed opening-balance import for one organization physically impossible.
**Verified against:** PostgreSQL 16.

---

## Mechanism

A B-tree unique index in Postgres does exactly one thing at the storage layer: on every INSERT or UPDATE that touches the indexed columns, it looks up the new key in the index and raises `23505` if a live (non-deleted, uncommitted-DELETE-aside) row already has it. A **partial** index adds a `WHERE` predicate to the `CREATE INDEX` statement itself:

```sql
CREATE UNIQUE INDEX ux_migration_imports_one_committed_opening
  ON migration_imports (org_id)
  WHERE kind = 'OPENING_BALANCES' AND status = 'COMMITTED';
```

The predicate is evaluated **at index-maintenance time**, not query time. Only rows for which the predicate is true are entered into the index structure at all — a `DRAFT` opening-balances import, or a `COMMITTED` chart-of-accounts import, never appears in this index, so it occupies no space and is invisible to the uniqueness check. The moment an `UPDATE` flips a row's `status` to `'COMMITTED'` while `kind = 'OPENING_BALANCES'`, Postgres inserts that row's `org_id` into the index as part of the same statement, and if another row for the same `org_id` is already in there, the whole statement aborts with `23505` before it can commit.

This is why the migration's own comment calls it "the guarantee, not the service": the check happens inside the database's own MVCC machinery, at the same moment the row becomes visible to everyone else, with no window for a second transaction to slip through in between.

A subtlety worth knowing cold: the predicate must be **immutable** with respect to the columns it references — it cannot call `now()` or read outside the row. Postgres enforces this at `CREATE INDEX` time; a predicate the planner cannot prove is deterministic is rejected outright.

## Why we chose it here

The alternative was a service-level check: `SELECT count(*) FROM migration_imports WHERE org_id = $1 AND kind = 'OPENING_BALANCES' AND status = 'COMMITTED'` before allowing a commit. That has a classic check-then-act race — two concurrent commit requests for the same organization can both pass the `SELECT` before either has written its `COMMITTED` row, and both then commit, silently doubling every opening balance in the books. A `SELECT ... FOR UPDATE` lock on some row would close the race but there is no natural row to lock *before* the first commit has happened — there's nothing there yet to lock.

| Option | Trade-off | Verdict |
|---|---|---|
| Service-level count-then-insert check | Simple to read; has a real concurrent-request race, and the failure mode (a silently doubled opening balance) is exactly the kind of error this phase exists to prevent | Rejected |
| A full `UNIQUE (org_id, kind)` | Would forbid a second **draft**, not a second **commit** — a user re-uploading a corrected trial-balance CSV before committing the first attempt would be blocked for no reason | Rejected |
| `CHECK` constraint | A `CHECK` sees one row in isolation; it cannot see whether another row with the same `org_id` already exists, so it cannot express "at most one across the table" at all | Rejected — the wrong tool by construction |
| Partial unique index | Enforced by the same MVCC machinery as any other unique index — no separate lock, no race window, and it costs nothing for every organization that never touches opening-balance import at all | **Chosen** |

This is the same discipline the codebase already applies with `EXCLUDE ... USING GIST` for `fiscal_periods` (see [exclusion-constraints-and-gist.md](exclusion-constraints-and-gist.md)): when a business rule can be phrased as "this predicate over these rows is never true twice," push it into an index rather than a service-level `SELECT`, because the index closes the race a service check cannot.

## Where it lives in this codebase

- `server/src/db/migrations/029_ledger-core_migration_imports.sql` — `ux_migration_imports_one_committed_opening`, the index itself.
- `server/src/services/ledger-core/openingBalanceImportService.ts` — `commitOnClient`'s final `UPDATE ... SET status = 'COMMITTED'` is the statement that can trigger `23505`.
- `server/src/services/ledger-core/migrationImportService.ts` — `commit()`'s `catch` block maps `pgErrorCode(err) === '23505' && pgConstraint(err) === 'ux_migration_imports_one_committed_opening'` to a friendly `409`. The constraint name is matched explicitly, not inferred from the message text, so a coincidental unique-violation on an unrelated constraint is never mis-reported as "already committed."
- `server/src/__tests__/ledger-core/openingBalanceImport.test.ts` — `"a second committed opening-balance import is refused"` proves both halves: the HTTP path returns `409`, and then a raw `pool.query` forces a second row to `VALIDATED` and issues the identical `UPDATE` the service issues, asserting it is rejected with `23505` on that exact constraint name — proof that the *database*, not application logic, is what refuses it.

## Gotchas

- **A partial index only serves a query whose `WHERE` clause implies the index's predicate.** An unqualified `SELECT * FROM migration_imports WHERE org_id = $1` will not use this index for planning (it can't — most rows aren't in it); only a query that also filters on `kind = 'OPENING_BALANCES' AND status = 'COMMITTED'` benefits from it as a lookup path. Its purpose here is the uniqueness guarantee, not query performance.
- **`NULL` values are never considered equal in a unique index**, partial or not — two rows with `NULL` in an indexed column both pass a unique check, even though `NULL = NULL` is `NULL`, not true, in ordinary SQL. This index sidesteps the question entirely: `org_id` is `NOT NULL`, so it never arises here, but it's the sharp edge to know when reasoning about a partial-unique design that *does* have a nullable column.
- **The predicate can reference other CHECK-constrained columns safely, but not a subquery** — `WHERE kind = 'OPENING_BALANCES' AND status = 'COMMITTED'` are both plain equality tests against columns already CHECK-constrained to a fixed set of literals in this same migration, which is what makes Postgres willing to call the predicate immutable.
- **Forgetting `IF NOT EXISTS` breaks idempotency** — like every other DDL statement in this codebase's migrations, a partial index is created with `CREATE UNIQUE INDEX IF NOT EXISTS`, so re-running the migration file (the runner's own idempotency check) is a no-op rather than a `42P07` duplicate-index error.

## Interview Q&A

**Q: What's the difference between a partial index and a regular index with a `WHERE` clause on the query?**
A: A `WHERE` clause on a query is evaluated per-query, against whatever rows a regular (full) index already contains — every row is still in the index, the filter just narrows what's read back. A partial index's `WHERE` clause is evaluated once, at *write* time, and decides whether a row is added to the index's own structure at all. The practical consequence: a full index's uniqueness check always spans every row in the table; a partial index's uniqueness check only ever spans the rows matching its predicate — which is exactly the behavior "unique only when committed and only for opening balances" needs.

**Q: Why not just enforce this with a `CHECK` constraint instead?**
A: A `CHECK` constraint is evaluated against a single row in isolation — it has no way to look at any other row in the table, so it fundamentally cannot express "this row must be the only one with property X across the whole table." That's a table-level invariant, and in Postgres the two tools that can express a table-level invariant on write are a unique index (equality) and an exclusion constraint (any operator, including range overlap — see the `fiscal_periods` note). A `CHECK` is the wrong category of tool here, not merely a worse choice.

**Q: How does this actually prevent a race between two concurrent commit requests?**
A: Both requests eventually try to `UPDATE ... SET status = 'COMMITTED'` on their own row. Postgres processes each `UPDATE`'s index maintenance as part of that statement, inside that transaction. Whichever transaction's `UPDATE` executes (and index-inserts) first holds an implicit lock on that index entry until it commits or rolls back; the second transaction's attempt to insert the same `org_id` key blocks until the first resolves, and once the first commits, the second's insert immediately fails with `23505` because the key is now genuinely a duplicate. There's no window where both can believe they're first — that's precisely the race a `SELECT`-then-`UPDATE` service check cannot close, because the `SELECT` and the `UPDATE` are two separate statements with an arbitrarily large gap between them under concurrent load.

**Q: What HTTP status and error code would you map a `23505` on this constraint to, and why not a generic 500?**
A: `409 Conflict` — the request is well-formed and the caller did nothing wrong; it's the *current state of the world* (another committed import already exists) that makes this particular request impossible right now. A `500` would say "the server broke," which is false and would send an operator down the wrong debugging path; a `422` would suggest the request body itself was invalid, which is also false — the same request would have succeeded five minutes earlier. Rule of thumb this codebase follows throughout: map a Postgres unique-violation on a business-meaningful constraint to `409`, matched by the constraint's *name*, never by pattern-matching the error message text (which can change across Postgres versions).

**Q: Does creating a partial index take a lock that blocks writes, like a regular `CREATE INDEX` can?**
A: Yes, a plain `CREATE UNIQUE INDEX` (partial or not) takes a `SHARE` lock on the table for the duration of the build, which blocks writes but not reads. For a table with existing rows in production, `CREATE UNIQUE INDEX CONCURRENTLY` avoids that by building the index in two passes without holding the blocking lock — at the cost of not being usable inside the same transaction block as other DDL, and needing a manual check afterward for `INVALID` if it was interrupted. This migration uses the plain (blocking) form because it runs against an empty or near-empty `migration_imports` table — this codebase's `migrations-and-schema-evolution.md` note covers the concurrent-build tradeoff in more depth for a table that already has real traffic.

## Follow-ups they'll dig into

- "What if the predicate itself needs to change later — can you `ALTER` a partial index's `WHERE` clause?" No — Postgres has no `ALTER INDEX ... WHERE`; you drop and recreate it (ideally `CONCURRENTLY`, then swap).
- "What does `EXPLAIN` show you when a query *doesn't* benefit from a partial index because its `WHERE` doesn't imply the index's predicate?" A sequential scan or a different index, with the partial index simply absent from the plan — the planner silently declines to use an index it can't prove is safe to use, it doesn't error.
- "How is this different from a `UNIQUE` constraint that's `DEFERRABLE`?" Deferrability changes *when* the check runs (at `COMMIT` instead of immediately) but not *which* rows it applies to — orthogonal to partiality. This codebase's `deferred-constraint-triggers.md` note covers the deferred half of that combination.

## See also

- [exclusion-constraints-and-gist.md](exclusion-constraints-and-gist.md) — the sibling technique for "never true twice" when the predicate is range overlap rather than equality.
- [staged-import-and-two-phase-commit.md](../architecture/staged-import-and-two-phase-commit.md) — why this import has a validate/commit split in the first place.
- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the other place this codebase pushes a table-level invariant into the database rather than a service check.
