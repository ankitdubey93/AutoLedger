# Partial Unique Indexes: Uniqueness That Only Applies Sometimes

> `UNIQUE (a, b)` answers "is this pair ever repeated, anywhere in the table?" A partial unique index answers a narrower, often more honest question: "is this pair ever repeated *among rows that matter*?" — and lets every other row be duplicated freely.

**Category:** PostgreSQL
**Introduced by:** Phase 9b — `ux_migration_imports_one_committed_opening`, the constraint that makes a second committed opening-balance import for one organization physically impossible. Extended Phase 28 — StockLedger's one-default-code-scheme-per-org index, a barcode partial unique index, and `UNIQUE NULLS NOT DISTINCT` on the balance-cache key.
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

### A second shape: "at most one *default* row," not "at most one row"

`ux_migration_imports_one_committed_opening` answers "does this ever exist at all." `stock_code_schemes` needs a related but distinct question answered: an organization can have many code schemes (one per category, say), but **at most one can be marked `is_default`**.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_code_schemes_one_default
  ON stock_code_schemes (org_id)
  WHERE is_default = true;
```

Structurally identical to the opening-balance index — a predicate scoping the index to rows where `is_default = true` — but the write pattern it protects is different in an important way: setting a *new* default has to first un-set the *old* one, and that can't happen in a single `UPDATE` statement, because for one moment inside a naive "set new default, then clear the old one" sequence, two rows would both be `true` and the index would reject the second write. The service (`codeSchemeService.ts`'s `setDefault`) handles this with two statements inside one transaction — clear every other default for the org first, then set the requested one — so the index only ever sees a state with zero or one `true` rows at each statement boundary, never two. This is the same reasoning `document-lifecycle-fsm.md` gives for why a status flip and its side effects share one transaction: the constraint is checked per-statement, so the *order* of a multi-statement write has to guarantee the invariant never transiently breaks in a way that would fail, not just that it holds at the end.

### A third shape: a partial unique index over a nullable, optional field

`stock_items.barcode` is nullable — most items don't carry a GS1 barcode, but any item that does must have a barcode no other item in the org shares:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_items_org_barcode
  ON stock_items (org_id, barcode)
  WHERE barcode IS NOT NULL;
```

Without the `WHERE barcode IS NOT NULL` predicate this would still technically work — as the next Gotcha explains, `NULL` is never considered equal to another `NULL` in a *unique* index anyway, so a plain `UNIQUE (org_id, barcode)` would already let unlimited `NULL`-barcode rows coexist. The predicate is added regardless, for the same reason `jsonb-user-defined-attributes.md` prefers `jsonb_path_ops` over the default opclass: it's smaller and faster, because rows that will never participate in the uniqueness check (every item with no barcode — the common case) are never entered into the index structure at all, rather than being entered and then never colliding.

### `UNIQUE NULLS NOT DISTINCT` — when you *do* want `NULL = NULL`

`stock_balances`'s natural key is `(org_id, item_id, location_id, lot_id)`, but `lot_id` is nullable — a `QUANTITY`-tracked item (no lot tracking) always has `lot_id IS NULL`, and there must still be exactly **one** balance row per `(org_id, item_id, location_id)` for such an item, not unlimited rows each with a `NULL` lot. This is the exact opposite of the barcode case: there, multiple `NULL`s should be allowed to coexist (many items with no barcode); here, multiple `NULL`s for the same `(item, location)` must **not** coexist (there is only one "no lot" balance per item per location).

A plain `UNIQUE (org_id, item_id, location_id, lot_id)` cannot express this, because standard SQL uniqueness treats every `NULL` as distinct from every other value, including another `NULL` — two rows with the same `(org_id, item_id, location_id)` and both `lot_id IS NULL` would not violate a plain unique constraint at all. Postgres 15 added `UNIQUE NULLS NOT DISTINCT` specifically to close this gap:

```sql
CREATE TABLE stock_balances (
  ...
  UNIQUE NULLS NOT DISTINCT (org_id, item_id, location_id, lot_id)
);
```

With `NULLS NOT DISTINCT`, two rows are considered duplicates if every column matches **including** treating `NULL = NULL` as a match for uniqueness purposes (this does not change ordinary `WHERE lot_id = NULL` semantics elsewhere — `IS NULL` is still required for a genuine equality test in a query; it changes only what the constraint itself treats as a duplicate). This is what makes `INSERT ... ON CONFLICT (org_id, item_id, location_id, lot_id) DO UPDATE` in `movementService.ts`'s balance-upsert work correctly for lotless items — without it, every upsert attempt for a `NULL`-lot balance would insert a fresh row instead of ever conflicting with the existing one.

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
- `server/src/services/accounting/openingBalanceImportService.ts` — `commitOnClient`'s final `UPDATE ... SET status = 'COMMITTED'` is the statement that can trigger `23505`.
- `server/src/services/accounting/migrationImportService.ts` — `commit()`'s `catch` block maps `pgErrorCode(err) === '23505' && pgConstraint(err) === 'ux_migration_imports_one_committed_opening'` to a friendly `409`. The constraint name is matched explicitly, not inferred from the message text, so a coincidental unique-violation on an unrelated constraint is never mis-reported as "already committed."
- `server/src/__tests__/accounting/openingBalanceImport.test.ts` — `"a second committed opening-balance import is refused"` proves both halves: the HTTP path returns `409`, and then a raw `pool.query` forces a second row to `VALIDATED` and issues the identical `UPDATE` the service issues, asserting it is rejected with `23505` on that exact constraint name — proof that the *database*, not application logic, is what refuses it.
- `server/src/db/migrations/065_stock_setup.sql` — `ux_stock_code_schemes_one_default`
- `server/src/services/inventory/codeSchemeService.ts` — `setDefault`'s two-statement clear-then-set inside one transaction
- `server/src/db/migrations/066_stock_items.sql` — `ux_stock_items_org_barcode`
- `server/src/db/migrations/067_stock_movements.sql` — `stock_balances`'s `UNIQUE NULLS NOT DISTINCT (org_id, item_id, location_id, lot_id)`
- `server/src/services/inventory/movementService.ts` — `lockBalances`'s `INSERT ... ON CONFLICT (org_id, item_id, location_id, lot_id) DO NOTHING` upsert-then-lock, which depends on the `NULLS NOT DISTINCT` behavior to conflict correctly for lotless items
- `server/src/__tests__/inventory/stockConstraints.test.ts` — DB-tier tests proving a second default scheme is rejected, a duplicate barcode is rejected, and two `NULL`-lot balance rows for the same item/location collide as expected

## Gotchas

- **A partial index only serves a query whose `WHERE` clause implies the index's predicate.** An unqualified `SELECT * FROM migration_imports WHERE org_id = $1` will not use this index for planning (it can't — most rows aren't in it); only a query that also filters on `kind = 'OPENING_BALANCES' AND status = 'COMMITTED'` benefits from it as a lookup path. Its purpose here is the uniqueness guarantee, not query performance.
- **`NULL` values are never considered equal in a unique index**, partial or not — two rows with `NULL` in an indexed column both pass a unique check, even though `NULL = NULL` is `NULL`, not true, in ordinary SQL. This index sidesteps the question entirely: `org_id` is `NOT NULL`, so it never arises here, but it's the sharp edge to know when reasoning about a partial-unique design that *does* have a nullable column.
- **The predicate can reference other CHECK-constrained columns safely, but not a subquery** — `WHERE kind = 'OPENING_BALANCES' AND status = 'COMMITTED'` are both plain equality tests against columns already CHECK-constrained to a fixed set of literals in this same migration, which is what makes Postgres willing to call the predicate immutable.
- **Forgetting `IF NOT EXISTS` breaks idempotency** — like every other DDL statement in this codebase's migrations, a partial index is created with `CREATE UNIQUE INDEX IF NOT EXISTS`, so re-running the migration file (the runner's own idempotency check) is a no-op rather than a `42P07` duplicate-index error.
- **A three-way choice, not a two-way one, when a nullable column meets uniqueness.** "Allow unlimited nulls" is a partial index (`WHERE col IS NOT NULL`); "allow at most one null" is `NULLS NOT DISTINCT`; "nulls should never arise at all" is just `NOT NULL` on the column, which is the right answer whenever it's an option and neither of the other two.

## Interview Q&A

**Q: You need "at most one default row per organization," and switching the default means one row goes from default to not, and another goes the other way. Why can't a single `UPDATE` do this safely against a partial unique index?**
A: Because the index is checked as part of each statement's write, and a naive single statement that tries to set a new row to `is_default = true` without first clearing the old default would, for that instant, have two `true` rows — which the index refuses. The fix isn't in the index at all; it's sequencing the write as two statements in one transaction — unset every other default for the org, then set the requested one — so the index only ever observes a state with zero or one `true` rows at each statement's completion, never two at once.

**Q: `stock_items.barcode` is nullable and only unique when present. Would a plain `UNIQUE (org_id, barcode)` already handle that correctly, given `NULL` is never equal to `NULL`?**
A: Functionally, yes — a plain unique constraint already lets unlimited `NULL` barcodes coexist, since standard SQL never treats two `NULL`s as duplicates for uniqueness purposes. The partial index is added anyway for a performance reason, not a correctness one: without the `WHERE barcode IS NOT NULL` predicate, every barcode-less item (the common case) still gets an index entry that can never participate in a conflict, wasting space and index-maintenance work on rows the check will never care about.

**Q: What does `UNIQUE NULLS NOT DISTINCT` change, and why did Postgres wait until version 15 to add it?**
A: By default, SQL uniqueness treats every `NULL` in an indexed column as distinct from every other value including another `NULL` — so a plain unique constraint can't express "at most one row where this column is `NULL`," only "at most one row for each actual value." `NULLS NOT DISTINCT` flips that for a specific constraint: it treats `NULL = NULL` as a match for the purposes of deciding whether two rows collide. It's a genuinely useful but narrow need — most schemas either want the standard behavior or work around its absence with a partial index (as this same file does for the barcode case) — which is likely why it took until Postgres 15 to land as its own syntax rather than earlier.

**Q: When would you reach for `UNIQUE NULLS NOT DISTINCT` instead of a partial unique index, given both can express "uniqueness involving a nullable column"?**
A: They solve opposite problems and aren't really substitutes. A partial index (`WHERE col IS NOT NULL`) says "don't enforce uniqueness at all when this column is null" — many nulls are fine. `NULLS NOT DISTINCT` says "treat null as a real value for uniqueness, including collapsing multiple nulls into a conflict" — at most one null is fine. `stock_balances` needs the second: a `NULL` lot_id represents a real, specific balance state ("no lot tracking for this item"), and there must be exactly one such row per item/location, not unlimited ones — which is exactly what `NULLS NOT DISTINCT` is for and a partial index cannot express.

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
- [../architecture/inventory-valuation-and-perpetual-stock.md](../architecture/inventory-valuation-and-perpetual-stock.md) — the balance cache `UNIQUE NULLS NOT DISTINCT` protects
- [transactions-isolation-pooling.md](transactions-isolation-pooling.md) — the deterministic lock ordering used when several `stock_balances` rows (each keyed through this same index) are locked together
