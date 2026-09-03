# Deferred Constraint Triggers

> A CHECK constraint sees one row, so a rule spanning many rows can only be enforced by a trigger — and only a `DEFERRABLE INITIALLY DEFERRED` constraint trigger can wait until `COMMIT`, when the rows finally exist.

**Category:** PostgreSQL
**Introduced by:** Phase 3 — `004_ledger-core_journals.sql`, enforcing that every journal entry's debits equal its credits
**Verified against:** PostgreSQL 16, `pg` (node-postgres) 8.x

---

## Mechanism

### Why a CHECK cannot do this

A `CHECK` constraint is evaluated per row, against that row's own columns. It can express "`debit_cents >= 0`" or "not both sides populated", because both are properties of a single `ledger_lines` row.

It cannot express "the debits of every line sharing this `journal_entry_id` sum to the credits". That is a property of a *set* of rows. PostgreSQL will let you write a subquery inside a CHECK only by wrapping it in a function, and the documentation is explicit that this is unsupported: the constraint is not re-evaluated when the *other* rows change, so it silently rots.

### The four trigger timings

| Timing | Fires | Sees |
|---|---|---|
| `BEFORE` row | Before the row is written | The proposed row; can modify `NEW` or abort |
| `AFTER` row | After the row is written | The written row; too late to modify it |
| `AFTER STATEMENT` | Once per statement | Transition tables, if declared |
| **`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`** | **At `COMMIT`** | Whatever the transaction has accumulated |

Only the last one is useful for a multi-row invariant, and the reason is timing rather than power.

### Why deferral is the whole point

Posting a two-line entry is at minimum two statements. Insert the debit line, and at that instant the entry has debits of 45000 and credits of 0. It is **transiently unbalanced** — and it must be, because there is no way to write two rows simultaneously.

An immediate trigger would reject the first line every time, making a balanced entry impossible to write. Deferring moves the check to the end of the transaction:

```sql
CREATE CONSTRAINT TRIGGER trg_ledger_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();
```

`DEFERRABLE` says deferral is *permitted*; `INITIALLY DEFERRED` says it is the default. With only `DEFERRABLE`, the trigger fires immediately unless a session opts in with `SET CONSTRAINTS … DEFERRED`.

Postgres queues one *trigger event* per affected row and drains the queue at `COMMIT`. So a three-line entry fires the function three times, each recomputing the same aggregate. That is wasteful and correct; making it fire once needs an `AFTER STATEMENT` trigger with transition tables, which then misses the multi-statement case entirely.

### The failure surfaces at COMMIT, not at INSERT

This is the part that surprises people, and it changes how you write both the code and the tests:

```ts
await client.query('BEGIN');
await client.query('INSERT INTO ledger_lines ...');  // resolves fine
await client.query('INSERT INTO ledger_lines ...');  // resolves fine
await client.query('COMMIT');                        // ← throws here
```

A `try/catch` wrapped only around the inserts catches nothing. The `COMMIT` must be inside the `try`, and the `catch` must still `ROLLBACK` — which is safe, because a failed `COMMIT` leaves the transaction aborted rather than closed.

### The hole a lines-only trigger leaves

A trigger on `ledger_lines` only fires when `ledger_lines` changes. Insert a `journal_entries` row and nothing else, and no trigger fires at all — the entry has no lines, so "debits equal credits" is **vacuously true** and an empty entry sails through.

The fix is a second constraint trigger on the parent, also deferred:

```sql
CREATE CONSTRAINT TRIGGER trg_journal_entries_have_lines
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();
```

The same function serves both, branching on `TG_TABLE_NAME`.

### `NEW` and `OLD` are not always assigned

In a function handling `INSERT OR UPDATE OR DELETE`, the obvious `COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)` **raises an error** on `DELETE`: `NEW` is not merely NULL, it is *unassigned*, and referencing a field of it is a runtime error in PL/pgSQL. Branch on `TG_OP` instead.

Equally, the entry may have been deleted earlier in the same transaction, taking its lines with it by cascade. The function has to check the parent still exists and return early if not, or a legitimate delete fails at commit.

### Partial immutability — Phase 3.8's `ISSUED -> VOID` carve-out

`journal_entries`' immutability trigger (`reject_mutation()`) is absolute: any `UPDATE` or `DELETE` on a posted row raises `0A000`, full stop. Phase 3.8's `invoices` table needed something one degree more permissive — an issued invoice is immutable *except* for exactly one transition, voiding it, which may change `status`, `voided_at`, and `void_journal_entry_id` and nothing else. A plain "reject every UPDATE once ISSUED" trigger would make voiding impossible; a trigger that only checks `NEW.status <> OLD.status` would let a caller sneak an amount change through *alongside* a legitimate void.

The fix generalizes the same `BEFORE UPDATE` mechanism this note already covers, adding a **row-diff check** built from `to_jsonb`:

```sql
IF NOT (OLD.status = 'ISSUED' AND NEW.status = 'VOID') THEN
  RAISE EXCEPTION '...' USING ERRCODE = '0A000';
END IF;

IF to_jsonb(NEW) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at'
   IS DISTINCT FROM
   to_jsonb(OLD) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at' THEN
  RAISE EXCEPTION 'Voiding invoice % may not change any other field', OLD.id
    USING ERRCODE = '0A000';
END IF;
```

`to_jsonb(row)` casts the whole row — every column, by name — to a JSONB object; the `- 'col'` operator (JSONB's key-deletion operator) removes one key at a time, so `to_jsonb(NEW) - 'status' - 'voided_at' - 'void_journal_entry_id'` is "every other column, as JSONB." Comparing two such objects with `IS DISTINCT FROM` (rather than `<>`) matters because ordinary `<>` returns `NULL` — not `TRUE` — when either side is `NULL`, and `NULL` in an `IF` condition is treated as false, silently skipping the check; `IS DISTINCT FROM` treats `NULL` as a comparable value, so it is the only operator that can't be fooled by a `NULL` column into passing a row that actually changed.

This generalizes cleanly: a table needs no special-casing per column to gain "this transition may touch only these fields" — new columns are automatically included in the diff and therefore automatically protected, which is the safe failure direction for a posted financial document. The trade-off is the reverse of what the balance trigger optimizes for: that trigger's job is "let legitimate transient states through, catch the final state"; this one's job is "let exactly one named transition through, and even that one only within a narrow field allowlist."

### Trigger firing order for same-timing triggers

`invoices` carries *two* `BEFORE UPDATE` row triggers — `trg_invoices_immutable` (the guard above) and `trg_invoices_updated_at` (the shared `set_updated_at()` helper every mutable table uses). PostgreSQL does not fire same-timing, same-event row triggers in creation order; it fires them in **alphabetical order by trigger name**. `trg_invoices_immutable` sorts before `trg_invoices_updated_at`, so the guard evaluates against `NEW.updated_at` exactly as the calling service set it, before `set_updated_at()` has a chance to touch it. In this specific case the ordering is actually irrelevant to correctness — the row-diff explicitly excludes `updated_at` from its comparison — but the dependency is real in general: two `BEFORE` triggers on the same table can observe different values of `NEW` depending on naming, and relying on a specific order without excluding the field from comparison (or without renaming triggers to force an order) is a latent bug waiting for someone to rename one of them.

---

## Why we chose it here

The invariant is already checked in `journalService` before any SQL runs. The trigger exists because **application validation only holds for writes that go through the application**.

| Option | Trade-off | Verdict |
|---|---|---|
| Application check only | Simple, one place, easy to test | Rejected — a migration, a data-fix script, a future module, or one `psql` session bypasses it entirely |
| CHECK constraint | Declarative, cheap | Impossible — a CHECK sees one row, this spans rows |
| Immediate `AFTER` row trigger | Fires without deferral setup | Rejected — rejects the first line of every legitimate entry |
| **Deferred constraint trigger** | Fires once per row at COMMIT; errors surface at an unusual place | **Chosen** |
| Serializable isolation + application check | No trigger machinery | Rejected — solves concurrency, not "who wrote this row" |

The prior build enforced this class of rule in application code alone, and computed `isBalanced` with a `Math.abs(d - c) < 0.01` epsilon. Both failures are now structurally impossible: the amounts are `BIGINT` cents so the comparison is exact integer equality, and the comparison happens in the database where nothing can route around it. See [guardrails.md](../../docs/guardrails.md) rules 3 and 7.

---

## Where it lives in this codebase

- `server/src/db/migrations/004_ledger-core_journals.sql` — `assert_journal_entry_balanced()` and its two constraint triggers; `reject_mutation()` for immutability; `assert_account_is_postable()` as a plain `BEFORE INSERT` trigger, undeferred because it depends on one row only
- `server/src/services/ledger-core/journalService.ts` — the application-layer check, and the `catch` that translates SQLSTATE `P0001` into `ApiError(422)`
- `server/src/__tests__/ledger-core/ledgerConstraints.test.ts` — every case goes around the service, straight at the pool, because that is the only way to prove the database is doing the work
- `server/src/db/migrations/009_ledger-core_invoices.sql` — `reject_issued_invoice_mutation()`, the row-diff `ISSUED -> VOID` carve-out; `reject_non_draft_invoice_line_mutation()`, the absolute (no carve-out) version for `invoice_lines`
- `server/src/__tests__/ledger-core/invoiceConstraints.test.ts` — the invoice half of the same "bypass the service, hit the pool directly" testing discipline, including a case that asserts the *allowed* `ISSUED -> VOID` update still succeeds

---

## Gotchas

- **The error arrives at `COMMIT`.** Keep `COMMIT` inside the `try`, or the rejection escapes your error handling.
- **Never write `COALESCE(NEW.x, OLD.x)`** in a trigger handling `DELETE`. `NEW` is unassigned, not NULL. Branch on `TG_OP`.
- **A zero-line parent needs its own trigger.** "Sum of nothing equals sum of nothing" is true, and an empty entry is not.
- **`TRUNCATE` does not fire row-level triggers.** Convenient for test fixtures, and a real hole if you were relying on triggers for auditing.
- **`CREATE CONSTRAINT TRIGGER` supports neither `IF NOT EXISTS` nor `OR REPLACE`.** Migrations must `DROP TRIGGER IF EXISTS` first to stay idempotent (rule 13).
- **Deferral is per row, not per statement.** A 500-line entry runs the aggregate 500 times at commit. Acceptable for journal entries; think again for bulk import.
- **A deferred trigger cannot stop a `SET CONSTRAINTS ALL IMMEDIATE` session** from changing the timing — but it cannot disable the check, only move it earlier.
- **`RAISE EXCEPTION` defaults to SQLSTATE `P0001`.** If you want callers to distinguish your errors, pass `USING ERRCODE = ...` — the immutability trigger uses `0A000` (`feature_not_supported`) so it is distinguishable from a balance failure.

---

## Interview Q&A

**Q: What is a deferred constraint trigger, and when would you reach for one?**
A: It is a trigger created with `CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`, which makes it fire at `COMMIT` rather than at statement time. You reach for it when the invariant spans multiple rows that cannot all exist at once. The case I built was double-entry bookkeeping: a journal entry's debits must equal its credits, but the lines are inserted one at a time, so after the first insert the entry is legitimately unbalanced. An immediate check would reject every valid entry. Deferring means the check runs once the whole transaction is assembled. A CHECK constraint can't do this at all, because a CHECK is evaluated against a single row.

**Q: Why enforce this in the database when the service already validates it?**
A: Because the service only protects writes that go through the service. A migration, a data-fix script, a future module written by someone who doesn't know the rule, or one careless `psql` session all bypass it. The distinction I'd draw is between a *rule* and an *invariant*: a rule is something the code tries to uphold, an invariant is something the system cannot violate. Moving the check into the database is what turns one into the other. It costs a trigger and some care in testing, and in exchange "the ledger is unbalanced" stops being a possible state, which for an accounting system is worth a lot.

**Q: What surprised you implementing it?**
A: Two things. First, the error surfaces at `COMMIT`, not at the `INSERT` — so my first test was written wrong: it asserted the insert would throw, and it didn't. I had to move the assertion onto the commit, and that reframed how I wrote the transaction wrapper, because `COMMIT` has to be inside the `try` block. Second, a trigger on the lines table doesn't catch an entry with *no* lines: nothing ever touches the lines table, so nothing fires, and "debits equal credits" is vacuously true of an empty set. I needed a second deferred trigger on the parent table to close that. That one wasn't in the original design — I found it by asking what the trigger could not see.

**Q: What if a table needs to be immutable *except* for one specific transition — say, an issued invoice that can still be voided?**
A: I generalized the same `BEFORE UPDATE` trigger technique with a row-diff built from `to_jsonb`. The trigger first checks that the transition is exactly the one allowed one (`OLD.status = 'ISSUED' AND NEW.status = 'VOID'`), then compares `to_jsonb(NEW)` against `to_jsonb(OLD)` with a handful of permitted columns subtracted out of both sides via JSONB's `-` key-deletion operator, using `IS DISTINCT FROM` rather than `<>` so a `NULL` column can't slip past the check. If anything outside the allowlist changed, it raises. The nice property is that it needs no per-column special-casing — a new column added to the table later is automatically covered by the diff and therefore automatically frozen once issued, which is the safe direction to fail in.

**Q: How do you test a database-level guarantee?**
A: Deliberately bypassing the application. All my constraint tests talk straight to the connection pool and write raw SQL, because a test that posts through the service proves the service is correct, which is the thing I was *already* confident about. The whole claim is that the database holds when the service isn't involved, so the test has to not involve it. I also assert on SQLSTATE rather than message text — `23514` for a CHECK, `0A000` for the immutability trigger — because messages get reworded and error codes are the actual contract.

---

## Follow-ups they'll dig into

- *"What's the performance cost?"* One function call per affected row, at commit, each running an aggregate over that entry's lines. Fine for journal entries of a handful of lines; for bulk import you'd want an `AFTER STATEMENT` trigger with transition tables, or to defer validation to a batch check.
- *"What if two transactions post to the same entry concurrently?"* They can't, in this schema — an entry and its lines are created in one transaction and are immutable afterwards. If lines could be appended later, the aggregate would need `SELECT … FOR UPDATE` on the parent, or SERIALIZABLE with a retry loop.
- *"How would you handle a genuinely unbalanced import?"* A suspense account. You post the difference to a clearing account so the entry balances, and the outstanding balance in that account is itself the report of what needs fixing — which is what real accounting systems do.
- *"Could you have used a materialized view or a computed column instead?"* Neither enforces anything; they'd surface the problem after the fact rather than prevent it.

---

## See also

- [migrations-and-schema-evolution.md](migrations-and-schema-evolution.md) — why the trigger DDL has to be idempotent
- [transactions-isolation-pooling.md](transactions-isolation-pooling.md) — what `COMMIT` is actually doing when the trigger fires
- [double-entry-as-an-invariant.md](../architecture/double-entry-as-an-invariant.md) — the accounting rule this enforces
- [branded-types-for-money.md](../typescript/branded-types-for-money.md) — why the comparison is exact integer equality
