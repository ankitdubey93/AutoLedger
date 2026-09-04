# Exclusion Constraints and GIST: Making Overlap Physically Impossible

> `UNIQUE` answers "is this value ever repeated?" An `EXCLUDE` constraint answers the harder question a fiscal calendar actually needs: "does this row's *range* ever overlap another row's range, for the same tenant?" — a question equality can't express and a service-level check can't make race-free.

**Category:** PostgreSQL
**Introduced by:** Phase 4 — `fiscal_periods`, LedgerCore's first `EXCLUDE` constraint and the project's first `CREATE EXTENSION` statement.
**Verified against:** PostgreSQL 16.

---

## Mechanism

### The problem `UNIQUE` cannot solve

A fiscal period is a `(org_id, starts_on, ends_on)` row, and the one invariant that actually matters is: **no organization may have two periods whose date ranges overlap.** `UNIQUE (org_id, starts_on, ends_on)` rejects two periods with *identical* bounds, but two periods that merely overlap — `2026-01-01..2026-01-31` and `2026-01-15..2026-02-15` — are not equal on any column, so a uniqueness check waves them straight through. Overlap is not an equality relationship; it needs an operator (`&&`, "overlaps") that a `B-tree`-backed `UNIQUE` index has no way to evaluate, because a B-tree only ever answers "is this key equal to / less than / greater than that key," never "does this key's *range* intersect that key's range."

The naive fix — a service-level check, `SELECT 1 FROM fiscal_periods WHERE org_id = $1 AND daterange(starts_on, ends_on) && daterange($2, $3)` before the `INSERT` — has the same race as every other "check then write" pattern this codebase avoids elsewhere (see [transactions-isolation-pooling.md](transactions-isolation-pooling.md) on lost updates): two concurrent requests to generate the same fiscal year's periods can both run the check, both see no conflict, and both insert. The database needs to be the one place this is impossible, the same doctrine [deferred-constraint-triggers.md](deferred-constraint-triggers.md) establishes for the ledger's balance invariant.

### `EXCLUDE` as `UNIQUE`, generalized to any commutative operator

An exclusion constraint says: for every pair of rows, some comparison between them must be false, or the second row is rejected at write time. `UNIQUE` is the special case where that comparison is `=`:

```sql
-- These two are the same idea, differently spelled:
CONSTRAINT ux_example UNIQUE (org_id, code)
CONSTRAINT ex_example EXCLUDE USING btree (org_id WITH =, code WITH =)
```

Migration 015 generalizes the *operator*, not the mechanism:

```sql
CONSTRAINT ex_fiscal_periods_no_overlap EXCLUDE USING GIST (
  org_id WITH =,
  daterange(starts_on, ends_on, '[]') WITH &&
)
```

Read as: for any two rows in `fiscal_periods`, it must not be true that both `org_id`s are equal **and** their date ranges overlap. `EXCLUDE` supports a *list* of `column WITH operator` pairs, each checked pairwise against every other row, all of which must hold simultaneously for the constraint to fire — here, `=` for the tenant column and `&&` for the range column, evaluated together as one compound condition.

### Why GIST specifically, and why `btree_gist`

A B-tree index physically only supports total-order operators (`=`, `<`, `<=`, `>`, `>=`) because its structure — a sorted tree — has no way to represent "these two ranges partially overlap." **GIST** (Generalized Search Tree) is PostgreSQL's extensible index framework: instead of one hard-coded comparison semantics, GIST is parameterized by an *operator class* that defines how to bound, split, and compare arbitrary structured values — bounding boxes for geometric types, ranges for `daterange`/`int4range`/`tsrange`, and more. `daterange`'s built-in GIST opclass supports `&&` natively, which is what lets the second clause in the `EXCLUDE` list work at all.

The first clause — `org_id WITH =` — is the wrinkle. `org_id` is a plain `uuid`, and PostgreSQL's core distribution does not ship a GIST opclass for equality on scalar types; GIST's built-in vocabulary is range- and geometry-shaped. `btree_gist` is a bundled contrib extension that supplies GIST opclasses for the ordinary scalar types (`uuid`, `text`, `integer`, and others) by wrapping B-tree-style comparison inside a GIST-compatible interface. Without it, `EXCLUDE USING GIST (org_id WITH =, ...)` fails at `CREATE TABLE` time with an error naming the missing operator class — `btree_gist` is not optional plumbing here, it's the only way a multi-column `EXCLUDE` can mix "plain equality on this column" with "overlap on that one" inside a single GIST index.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

This is the project's first `CREATE EXTENSION` of any kind — the first schema feature that needed something beyond what a stock PostgreSQL install carries. It runs as the pool's connecting role, which the Docker Compose `postgres:16` image runs as a superuser for, matching the same posture `gen_random_uuid()`'s note in migration 001 already establishes about built-in cryptographic functions.

### `daterange(starts_on, ends_on, '[]')` — the inclusivity choice

PostgreSQL's range types carry an explicit bounds specifier: `'[]'` (closed-closed, both endpoints included), `'[)'` (closed-open, the default for `daterange` if omitted), `'()'`, `'(]'`. Every other date-window query in this codebase — `BETWEEN starts_on AND ends_on`, `entry_date <= p.ends_on` — already treats `ends_on` as inclusive, so the exclusion constraint has to agree: `daterange(starts_on, ends_on, '[]')` makes January's range include January 31st itself, matching what `assertPeriodOpenOnClient`'s `BETWEEN` check means by "covers this date."

Getting the bound wrong in either direction breaks a real case. With `'[)'` (exclusive of `ends_on`), two adjacent, correctly-non-overlapping periods — January ending the 31st, February starting the 1st — would still be flagged as touching if the check used `<=` semantics inconsistently; more subtly, with `'()'` a period could be defined with `starts_on = ends_on` and never actually exclude anything. `'[]'` is the form that makes "period touches this exact calendar day" mean the same thing everywhere in the codebase that asks it.

### `EXCLUDE` fires like a `UNIQUE` violation, not like a trigger

Unlike the ledger's balance rule, this doesn't need `DEFERRABLE INITIALLY DEFERRED` or a `CONSTRAINT TRIGGER` — an exclusion constraint is checked the same way a `UNIQUE` constraint is, per-row, at `INSERT`/`UPDATE` time, using the index itself to find candidate conflicting rows rather than scanning the whole table. A violation raises SQLSTATE `23P01` (`exclusion_violation`), the row-conflict sibling of `23505` (`unique_violation`) — `fiscalPeriodService.generatePeriods` catches exactly that code and maps it to a domestic `409`:

```ts
if (pgErrorCode(err) === PG_EXCLUSION_VIOLATION) {
  throw new ApiError(409, 'A fiscal period already overlaps this fiscal year');
}
```

This is what closes the same race the service-level pre-check couldn't: two concurrent `generatePeriods` calls for the same fiscal year both pass the pre-check's `SELECT`, both proceed to `INSERT` all twelve periods, and the *second* transaction's insert collides with the GIST index the first transaction just committed — one succeeds, one gets `23P01` and a readable `409`, and there is no window where both can succeed.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `UNIQUE (org_id, period_number, fiscal_year_label)` | Simple B-tree index, no extension needed | Rejected — permits two periods with different labels/numbers whose date ranges still overlap; catches duplicates, not overlaps |
| Service-level overlap `SELECT` before `INSERT` | No schema change, no extension | Rejected — check-then-write race: two concurrent requests can both pass the check before either commits |
| **`EXCLUDE USING GIST (org_id WITH =, daterange(...) WITH &&)`** | Needs `btree_gist`; a GIST index is heavier to write than a B-tree | **Chosen** — makes overlap structurally impossible, race-free, independent of what wrote the row |
| Application-level locking (advisory lock per org before generating periods) | No extension, works today | Rejected for this specific invariant — it only protects the one code path that remembers to take the lock; a raw `INSERT` from a script or a future service still bypasses it entirely |

---

## Where it lives in this codebase

- `server/src/db/migrations/015_ledger-core_fiscal_periods.sql` — `CREATE EXTENSION IF NOT EXISTS btree_gist`, `ex_fiscal_periods_no_overlap`
- `server/src/services/ledger-core/fiscalPeriodService.ts` — `generatePeriods`'s pre-check `SELECT` (a fast, non-authoritative filter) plus the `23P01` → `409` mapping (the real, race-free guarantee)
- `server/src/__tests__/ledger-core/fiscalPeriodConstraints.test.ts` — proves the constraint directly via raw SQL: two overlapping ranges in one org rejected, the identical overlap permitted across two different orgs, and adjacent non-overlapping ranges accepted

---

## Gotchas

- **`btree_gist` is required the moment a GIST exclusion constraint mixes a scalar equality column with a range column.** GIST alone has opclasses for ranges and geometry, not for plain `uuid`/`text`/`integer` equality — that gap is exactly what the extension fills.
- **The bounds specifier on the range expression must match every other place the same "inclusive/exclusive" question is asked.** `daterange(a, b, '[]')` and a `BETWEEN a AND b` check are only consistent if the range literal's inclusivity matches — get this wrong and the constraint either rejects legitimate adjacent periods or silently permits an overlap of exactly one day.
- **A GIST index is more expensive to maintain on write than a B-tree.** For a handful of periods per organization per year this is immaterial; it would matter for a table with thousands of overlapping-range rows inserted per second, which fiscal periods will never be.
- **`EXCLUDE` needs at least one operator per column, and every listed condition must hold for the row to be rejected.** A single-column `EXCLUDE USING GIST (daterange(...) WITH &&)` with no `org_id WITH =` clause would reject overlapping periods *across every organization*, which is the tenant leak this exact compound form exists to prevent (guardrails rule 1, expressed as a constraint instead of a query predicate).
- **The service-level pre-check in `generatePeriods` is a UX nicety, not the guarantee.** It exists so a normal, non-racing "generate periods for this org" request gets a clean idempotent no-op instead of relying on the exception path; the constraint is what actually holds under concurrency.

---

## Interview Q&A

**Q: What's the actual difference between `UNIQUE` and `EXCLUDE`?**
A: `UNIQUE` is `EXCLUDE` with the operator fixed to `=` on every listed column, backed by a B-tree. `EXCLUDE` generalizes that to any operator a chosen index type supports — most usefully `&&` (overlaps) on range or geometric types via GIST — and lets you list several `column WITH operator` pairs that must *all* hold for two rows to be considered conflicting. `UNIQUE (a, b)` is really just shorthand for `EXCLUDE USING btree (a WITH =, b WITH =)`.

**Q: Why can't a B-tree index enforce "no two ranges overlap"?**
A: A B-tree only knows total-order comparisons — a key is less than, equal to, or greater than another key, and the tree's structure (sorted, with each level narrowing a range of possible positions) depends on that total order existing. "Do these two ranges overlap" isn't a total-order question; two ranges can be genuinely incomparable (neither wholly before nor after the other) while still intersecting. GIST supports arbitrary operator classes that don't require a total order — a range type's GIST opclass knows how to bound a set of ranges and test containment/overlap directly, which a B-tree's comparison-based structure has no way to express.

**Q: Why do you need `btree_gist` just to check `org_id` equality inside a GIST index?**
A: GIST's built-in vocabulary in core PostgreSQL is oriented around ranges and geometric types — it ships opclasses for `&&`, containment, and similar spatial/range operators, not for plain scalar equality on `uuid` or `text`. `btree_gist` is a contrib extension that adds GIST-compatible opclasses for the ordinary scalar types, essentially teaching GIST how to do what a B-tree already does for equality, but through a GIST-compatible interface. Without it, you can't mix "equal on this column" and "overlaps on that column" in one GIST index at all — `CREATE TABLE` fails outright with a missing-operator-class error.

**Q: How does this avoid the race condition a service-level "check, then insert" would have?**
A: The constraint is enforced by the database at write time against the index, not by application code reading a snapshot and then acting on it. Two concurrent transactions can both run a pre-check `SELECT` and both see no conflict — that's the classic check-then-write race. But when both then attempt their `INSERT`, only one can actually commit a non-overlapping set of rows into the GIST index; the second transaction's insert collides with what the first just committed and gets rejected with `23P01`, regardless of what either transaction believed when it ran its check. The guarantee lives in the index, not in the timing of two separate queries.

**Q: What HTTP status and error code do you map an exclusion violation to, and why?**
A: `409 Conflict`, mapped from PostgreSQL's `23P01` (`exclusion_violation`) — the same status family `journalService` uses for `23505` (`unique_violation`) on a double reversal. `409` communicates "the request is valid in isolation, but conflicts with existing state" — exactly what "you tried to create a fiscal period that overlaps one that already exists" means, as opposed to `422` (the request itself is malformed) or `400` (bad input shape).

**Q: What inclusivity did you choose for the date range, and why does it matter?**
A: `daterange(starts_on, ends_on, '[]')` — closed on both ends, so `ends_on` itself counts as part of the period. Every other place in the codebase that reasons about a period's coverage — `BETWEEN starts_on AND ends_on` in `assertPeriodOpenOnClient` — is also inclusive of both endpoints, and the exclusion constraint has to agree or the invariant it's enforcing wouldn't match what the application code actually checks. Getting it wrong either direction is a real bug: too exclusive and two genuinely-overlapping periods could slip through; too inclusive (using `()`  incorrectly) and two adjacent, correctly back-to-back periods would be wrongly rejected as overlapping.

---

## Follow-ups they'll dig into

- *"What if you needed periods to be allowed to touch at a boundary but never overlap inside it?"* That's exactly what `'[]'` vs `'[)'` controls — `'[)'` (closed-open) would make two periods sharing an exact boundary date-count as touching-not-overlapping in a different sense, which is why the choice has to be made deliberately and matched against how the rest of the codebase reads the boundary.
- *"How would `EXPLAIN` show this constraint being checked?"* As an index scan against the GIST index during the `INSERT`'s constraint-checking phase, not as a separate query — worth running to see there's no extra round trip beyond the index lookup itself.
- *"Would this work for a `tstzrange` instead of a `daterange`, for a system with time-of-day precision?"* Yes — the same `EXCLUDE USING GIST` shape works for any range type with a GIST-compatible overlap operator; `tstzrange` ships one natively, no extension needed for the range column itself (only for mixing in the scalar equality column).

---

## See also

- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the other "the database is the guardrail, not the service" invariant in this codebase, enforced by a trigger instead of a constraint because it spans rows in a way an index-backed constraint can't express
- [transactions-isolation-pooling.md](transactions-isolation-pooling.md) — the general "check then write" race this constraint closes for one specific invariant
- [composite-foreign-keys-for-tenancy.md](composite-foreign-keys-for-tenancy.md) — another case of the database enforcing tenancy as a structural property of a constraint, not an application-level `WHERE` clause
- [../architecture/document-lifecycle-fsm.md](../architecture/document-lifecycle-fsm.md) — the FSM half of fiscal periods: close/lock transitions, checked in code and by CHECK, alongside this constraint's overlap guarantee
