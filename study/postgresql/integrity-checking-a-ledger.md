# Integrity Checking a Ledger

> A trigger guarantees an invariant holds for every *individual* write; a standalone checker re-derives the same invariants from scratch, unscoped, across the *entire* database — the difference between "the door is locked" and "let's actually walk the whole building and check every door," and why an auditor wants the second one, not a claim about the first.

**Category:** PostgreSQL
**Introduced by:** Phase 5 — `db/integrity.ts` / `scripts/verifyIntegrity.ts`, `npm run verify:integrity`
**Verified against:** PostgreSQL 16, `pg` (node-postgres) 8.22

---

## Mechanism

### Why a checker exists at all, given the triggers already enforce this

`journal_entries`/`ledger_lines` already carry a `DEFERRABLE INITIALLY DEFERRED` constraint trigger asserting every entry balances (see [deferred-constraint-triggers.md](deferred-constraint-triggers.md)), and an immutability trigger forbidding any `UPDATE`/`DELETE` on a posted row. Those are real, structural guarantees — but a guarantee enforced by triggers is a claim about what the *application's normal write path* cannot produce. It says nothing, by itself, about a row inserted by a one-off `psql` session with triggers momentarily disabled, a bulk import that ran before a trigger existed, a bug in a future migration, or literal data corruption. `verify:integrity` is the thing you run to get independent evidence the ledger is actually in the state the triggers claim it's in — a checker that re-derives the invariant from the data itself, trusting nothing about how the data got there.

### Aggregating a whole-table invariant with `HAVING`

The first check — every entry balances — needs "for each journal entry, do its lines' debits equal its credits":

```sql
SELECT e.org_id, l.journal_entry_id,
       SUM(l.debit_cents) AS total_debits,
       SUM(l.credit_cents) AS total_credits
  FROM ledger_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id
 GROUP BY e.org_id, l.journal_entry_id
HAVING SUM(l.debit_cents) <> SUM(l.credit_cents)
 LIMIT 20
```

`WHERE` filters rows before grouping; `HAVING` filters *groups* after the aggregate is computed — the only place a condition on `SUM(...)` can legally go, since a bare `WHERE SUM(...) <> SUM(...)` would be rejected: aggregates don't exist yet at the point `WHERE` is evaluated in the query's logical order of operations. An entry that balances produces no row here at all; the query's *result set itself* is the list of offenders, which is why an empty result means "passed" — there's no separate boolean to compute, the absence of rows is the proof.

### Anti-join for orphan detection

The third check needs "every ledger line whose journal entry either doesn't exist, or exists in the wrong tenant":

```sql
SELECT l.id, l.org_id, l.journal_entry_id,
       (e.id IS NULL) AS missing_parent,
       (e.id IS NOT NULL AND e.org_id <> l.org_id) AS tenant_mismatch
  FROM ledger_lines l
  LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
 WHERE e.id IS NULL OR e.org_id <> l.org_id
```

A `LEFT JOIN` keeps every row from `ledger_lines` regardless of whether a matching `journal_entries` row exists; where none matches, every column from `e` comes back NULL. `WHERE e.id IS NULL` isolates exactly the rows with no match at all — the classic **anti-join** pattern (find rows in A with no corresponding row in B), done with `LEFT JOIN ... WHERE ... IS NULL` rather than `NOT IN (SELECT ...)`, which has a well-known NULL-handling trap: if the subquery's column can ever contain a NULL, `NOT IN` against it returns no rows at all, silently, for the entire query. `LEFT JOIN`/`IS NULL` doesn't have that failure mode. `e.org_id <> l.org_id` catches the *worse* case in the same query — a line whose parent entry exists, but in a different organization than the line itself claims, a tenant-boundary violation this codebase treats as at least as serious as a missing parent.

### Why integer equality, never an epsilon

`debits_equal_credits` compares `BigInt` values with `===`, never `Math.abs(a - b) < epsilon`. Money in this codebase is `BIGINT` cents end to end (see [branded-types-for-money.md](../typescript/branded-types-for-money.md)); an integrity checker whose whole purpose is proving the books are exactly right cannot itself introduce the class of bug — floating-point tolerance — the entire schema exists to eliminate. `parseCents` converts the `BIGINT`-as-string PostgreSQL hands back into the branded `Cents` type, then the comparison happens as `BigInt`, not `Number`, so a genuinely enormous sum (beyond `Number.MAX_SAFE_INTEGER`, 2^53−1) still compares exactly rather than silently losing precision.

### Why this file is not allowed to be imported by a service

Every one of these queries runs with no `org_id` predicate at all — the opposite of every other query in this codebase, which guardrails rule 1 requires to be tenant-scoped. That's not an oversight; it's the entire point of a *global* integrity check: an invariant that holds "for this one organization" isn't the same claim as "for the whole database," and only the unscoped version can catch a bug that crosses a tenant boundary (exactly what the orphan check's tenant-mismatch case is designed to find). The file lives in `src/db/`, not `src/services/`, specifically so nothing under `src/services/` or `src/controllers/` — the code paths that serve actual HTTP requests — can import an unscoped query by accident. Every offender the checker reports still carries its own `org_id` in the output, so a failure remains traceable to one tenant even though the query that found it deliberately wasn't scoped to one.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Trust the triggers, no separate checker | Zero extra code | Rejected — a trigger proves what the normal write path can't produce, not what's actually in the table right now; an auditor wants the second claim |
| A scheduled job that runs this automatically | Continuous verification | Deferred — needs Phase 7's background-job infrastructure; this phase ships the checker as a script an operator runs on demand, which is the smaller, correctly-scoped piece |
| A materialized view of "unbalanced entries" | Queryable at any time without re-running | Rejected — a materialized view is stale until refreshed, and refreshing it is the same query anyway; it would suggest a false sense of "always current" |
| Assert via the application's own `isBalanced` logic, replayed over every row | Reuses existing code | Rejected — the entire point is independent verification; re-running the same code that (might) have a bug proves nothing new |
| **A standalone script over three explicit SQL queries, unscoped by design, with a documented exception to rule 1** | Small, auditable, honest about scope | **Chosen** |

See [docs/roadmap.md](../../docs/roadmap.md)'s Phase 5 entry: *"the script you run in front of an auditor, and it must be able to fail"* — which is why `server/src/__tests__/integrity.test.ts` deliberately manufactures broken data (via `ALTER TABLE ... DISABLE TRIGGER USER`, bypassing the very triggers this checker exists to double-check) rather than only ever asserting a healthy database passes.

---

## Where it lives in this codebase

- `server/src/db/integrity.ts` — `runIntegrityChecks()`, the three queries, pure (no process exit, no console output) so it is safely importable from a test
- `server/src/scripts/verifyIntegrity.ts` — the CLI tail: prints the report, calls `process.exit(report.passed ? 0 : 1)`. Split from `integrity.ts` on purpose — importing the script itself would terminate the test runner
- `server/package.json` — `"verify:integrity": "tsx src/scripts/verifyIntegrity.ts"`
- `server/src/__tests__/integrity.test.ts` — the four cases, including the two that disable triggers to prove the checker can actually fail

---

## Gotchas

- **`WHERE SUM(...) <> ...` is a syntax error.** Filtering on an aggregate requires `HAVING`, evaluated after `GROUP BY` in the query's logical order.
- **`NOT IN (SELECT ...)` silently returns nothing if the subquery can produce a NULL.** Use `LEFT JOIN ... WHERE right.col IS NULL` for anti-joins instead.
- **Comparing `BIGINT`-derived sums as JS `Number` risks silent precision loss** past `Number.MAX_SAFE_INTEGER`. Compare as `BigInt`.
- **This file must never be imported from `src/services/` or `src/controllers/`.** Every query in it is deliberately unscoped by `org_id` — the opposite of guardrails rule 1 everywhere else in the codebase — and importing it into a request-serving path would turn a documented, reviewed exception into an actual tenant-isolation bug.
- **A checker that never fails hasn't been tested.** `integrity.test.ts`'s two negative cases exist specifically because a passing-only test suite can't distinguish "the checker works" from "the checker is a no-op."

---

## Interview Q&A

**Q: You already enforce the balance invariant with a database trigger. Why build a separate integrity checker on top of that?**
A: The trigger is a guarantee about the *normal write path* — it proves the application, going through its own code, cannot commit an unbalanced entry. It says nothing about a row a migration wrote before the trigger existed, a bulk import that ran with triggers disabled, or a bug elsewhere. `verify:integrity` re-derives the same invariants directly from the data, trusting nothing about how the data got there — it's independent verification, which is a genuinely different and stronger claim than "the gate that's supposed to stop this exists."

**Q: Walk me through how you'd find every journal entry that doesn't balance.**
A: `GROUP BY` the entry, `SUM` debits and credits per group, and filter with `HAVING SUM(debits) <> SUM(credits)` rather than `WHERE`, because the condition depends on an aggregate that doesn't exist until after grouping happens. An entry that balances never appears in the result at all — the result set itself is the list of offenders, so an empty result is the pass condition.

**Q: How do you find rows whose foreign key points at something that doesn't exist, or exists in the wrong place?**
A: A `LEFT JOIN` to the referenced table, then `WHERE right.id IS NULL` for "doesn't exist at all" — the standard anti-join pattern, safer than `NOT IN (subquery)`, which returns zero rows for the whole query if the subquery's column can contain NULL, a trap that's easy to hit by accident and hard to notice, since it fails silently rather than erroring. I extended the same query to also catch a "exists, but in the wrong organization" case by adding an OR clause comparing `org_id` across the join — a tenant-boundary violation is arguably worse than a plain missing row, and one query can catch both.

**Q: Why does this file get an explicit exception to your rule that every query must be scoped by `org_id`?**
A: Because the entire point of a global integrity check is to prove something about the whole database, and a per-tenant query structurally can't do that — it would need to run once per organization and you'd have no single "is the ledger sound" answer. I documented the exception directly in the file, restricted the file's location so nothing request-serving can import it, and made sure every offender the checks report still carries its own `org_id`, so a failure is traceable to a tenant even though the query that found it wasn't scoped to one.

**Q: How did you test something whose job is to detect broken data, when your schema is specifically designed to prevent broken data from existing?**
A: I had to deliberately manufacture the broken state the checker exists to catch, which meant going around the very triggers that normally prevent it — `ALTER TABLE ... DISABLE TRIGGER USER` inside the test, insert an unbalanced entry or a cross-tenant line directly, run the checker, assert it fails, then re-enable the triggers in a `finally` so the broken row and disabled trigger state don't leak into the next test. Without that, I'd only have tests proving the checker passes on a healthy database, which can't distinguish a correct implementation from one that always returns `passed: true`.

---

## Follow-ups they'll dig into

- *"How would you run this continuously rather than on demand?"* A scheduled job — this codebase's background-job infrastructure (Phase 7) is the natural home for it, running the same `runIntegrityChecks()` on a cron and alerting on `passed: false`, rather than waiting for someone to run the npm script.
- *"What would you do differently at a much larger scale — millions of ledger lines?"* The per-entry balance check and the orphan check both do full-table scans today. At scale you'd want to checkpoint — track a high-water mark of what's already been verified — and only check rows written since the last run, plus periodic full sweeps as a backstop.
- *"What's the difference between this and a database constraint?"* A constraint (or trigger) is enforced at write time, continuously, and can reject a bad write before it happens. This checker runs on demand, after the fact, and can only report — it can't undo anything. They're complementary: the constraint is prevention, the checker is verification that prevention actually worked.
- *"Could two of these checks disagree — pass one, fail another, in a way that's contradictory?"* Not by construction here — `debits_equal_credits` is a database-wide sum, `every_entry_balances` is per-entry; a single unbalanced entry fails both, since it moves the global sum by exactly its own imbalance. They're intentionally overlapping rather than fully independent, which makes a failure easier to localize, not harder.

---

## See also

- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the write-time guarantee this checker independently re-verifies
- [audit-triggers-and-session-variables.md](audit-triggers-and-session-variables.md) — Phase 5's other half, the who/when trail this checker doesn't itself provide
- [branded-types-for-money.md](../typescript/branded-types-for-money.md) — why the comparison is exact `BigInt` equality, never a float
- [subledger-reconciliation-and-aging.md](subledger-reconciliation-and-aging.md) — another "does a derived total match the ledger" check, at the AR/AP subledger level rather than the whole database
