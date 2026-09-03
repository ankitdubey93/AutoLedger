# Composite Foreign Keys as a Tenancy Boundary

> A normal foreign key can only promise "this id exists somewhere" — a composite foreign key that includes `org_id` on both sides can promise "this id exists, *and it belongs to the same organization as the row referencing it*," turning a service-level tenancy check into something the database physically cannot violate.

**Category:** PostgreSQL
**Introduced by:** Phase 3.5 — `ledger_settings.cash_account_id`, which must point at an `accounts` row in the *same* organization, not merely at some `accounts` row somewhere
**Verified against:** PostgreSQL 16

---

## Mechanism

### What a single-column FK actually promises

`ledger_settings.cash_account_id UUID REFERENCES accounts(id)` guarantees exactly one thing: the value, if present, matches some row's `accounts.id`. It says nothing about which organization that row belongs to. Given

```sql
ledger_settings (org_id, cash_account_id)
accounts        (org_id, id)
```

a plain single-column FK on `cash_account_id` is perfectly satisfied by an `accounts` row belonging to a **different** organization than the `ledger_settings` row referencing it — the constraint has no way to see `org_id` at all, because it wasn't asked to. Enforcing "same org" then falls entirely on application code: a service-layer `SELECT ... WHERE id = $1 AND org_id = $2` before the write. That check is real, but it is not the same *kind* of guarantee as a constraint — it can be skipped by a different code path, a raw `psql` session, a future migration's data-fix script, or simply forgotten in code review. Guardrails rule 1 exists precisely because "the service remembers to check" has a worse failure mode than "the database cannot represent the bad state."

### Making the database represent the invariant instead of trusting code to check it

A **composite foreign key** references more than one column, and the trick is choosing the referenced table's key to include the tenant column:

```sql
-- accounts needs a composite UNIQUE target before anything can reference it as a pair.
ALTER TABLE accounts ADD CONSTRAINT ux_accounts_org_id_id UNIQUE (org_id, id);

CREATE TABLE ledger_settings (
  org_id          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  cash_account_id UUID,
  ...
  CONSTRAINT fk_ledger_settings_cash_account
    FOREIGN KEY (org_id, cash_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);
```

Two things had to be true before this FK could exist. First, `FOREIGN KEY` can only reference a column set that is unique on the target side — `accounts.id` alone is already `PRIMARY KEY` and therefore unique, but `(org_id, id)` as a *pair* is not automatically unique just because one half of it is; Postgres needs an explicit `UNIQUE (org_id, id)` (or a `PRIMARY KEY` on that pair) to accept it as a valid FK target. That's genuinely redundant information — `id` alone already determines `org_id` uniquely, since every account belongs to exactly one organization — but the FK mechanism only understands "this exact tuple of columns is guaranteed unique," not "one of these columns functionally determines the other." The redundant unique index is the price of asking the constraint system to check a two-column fact.

Second, with that composite unique index in place, the FK `(org_id, cash_account_id) REFERENCES accounts (org_id, id)` now checks *both* columns together: for the row to be valid, there must exist an `accounts` row where **both** `id = cash_account_id` **and** `org_id` matches. An attempt to set `cash_account_id` to a real account id from a different organization fails at the database with a foreign-key violation (`23503`), regardless of which code path produced the `INSERT` or `UPDATE` — a correct service, a buggy one, or a hand-written `psql` statement all hit the same wall.

### `MATCH SIMPLE` and why a nullable column in the key still works

Postgres composite FKs default to `MATCH SIMPLE` (as opposed to `MATCH FULL`): if *any* column in the FK's column set is `NULL`, the constraint is considered satisfied without checking the others at all. `ledger_settings.cash_account_id` is nullable — an organization that hasn't configured a cash account yet has `cash_account_id = NULL` — and under `MATCH SIMPLE` that row passes the constraint immediately, since one of the two columns (`cash_account_id`) is null, regardless of what `org_id` is. This is exactly the wanted behavior: "no cash account configured" is a legitimate state, not a violation.

`MATCH FULL` would instead require *all* columns to be `NULL` or *none* to be — useful when a partial reference (one column set, the other not) is itself invalid, which is not the case here since `org_id` is `NOT NULL` on this table regardless. `MATCH SIMPLE` (the default, and the one used here) is the right choice whenever the nullable column is the *optional* half of an otherwise-mandatory pair.

### `ON DELETE` on a composite key — the trap that looks obviously right and isn't

The instinct for "clean up a broken reference" is `ON DELETE SET NULL`. On a **composite** FK this is a real trap: `SET NULL` nulls out *every* column in the FK's local column set, not just the one that conceptually "points" at the deleted row. Here that column set is `(org_id, cash_account_id)` — so deleting the referenced `accounts` row would attempt to null `ledger_settings.org_id` too, and `org_id` is this table's `NOT NULL` primary key. The constraint would fail with a not-null violation the moment it tried to fire, in a way that's confusing to debug because the error looks like it's about the wrong column.

The fix here is `ON DELETE RESTRICT`, which never fires in practice anyway, because `accounts` rows are never actually deleted in this system — an account is retired by setting `is_active = false`, and the accounts FK itself is `ON DELETE RESTRICT` for the same audit-trail reason journal entries are immutable. `RESTRICT` is the honest choice: it says "this reference cannot be silently invalidated," rather than picking a cleanup behavior (`SET NULL`, `CASCADE`) that happens to be wrong for a composite key referencing a `NOT NULL` primary key column.

### Why not just a service-level check plus an index?

A service check (`SELECT 1 FROM accounts WHERE id = $1 AND org_id = $2`) followed by the write is the alternative, and it is what most of this codebase's *other* cross-references still rely on — `accounts.parent_id` re-parenting, for instance, checks same-org and same-type in `accountService` rather than in a constraint, because "same type" isn't FK-expressible at all. The difference with `cash_account_id` is that "same organization" *is* expressible as a plain equality across two columns, which is exactly what a composite FK checks natively. Where a constraint can express the whole invariant, preferring it over an equivalent service check removes an entire class of future bug: a second code path, a batch script, or a bugfix six months from now cannot reintroduce the leak, because the leak is no longer representable in the schema at all.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Single-column FK + a service-layer same-org `SELECT` before every write | Familiar, no schema change | Rejected as the *only* protection — every future write path (migrations, scripts, a bugfix) has to remember to repeat the check |
| **Composite FK `(org_id, x_id) REFERENCES t (org_id, id)`, with the required `UNIQUE (org_id, id)`** | One redundant unique index; `ON DELETE` needs care | **Chosen** — same-org is unrepresentable as a violation, at the database level, from any code path |
| Row-level security (`CREATE POLICY`) scoping all access by `org_id` | Enforced on every query automatically, not just this one FK | Rejected for this specific problem — RLS scopes *visibility*, not cross-row referential correctness; it wouldn't stop `cash_account_id` from pointing at an org-B row that org-A's session simply can't see, which is actually worse (a dangling, invisible reference) |
| A `CHECK` constraint comparing the two org_ids | Simplest to write | Not possible — a `CHECK` on `ledger_settings` cannot see `accounts.org_id` at all; it only ever sees columns of the row being checked, not another table's row |

---

## Where it lives in this codebase

- `server/src/db/migrations/005_ledger-core_settings.sql` — `ux_accounts_org_id_id`, `fk_ledger_settings_cash_account`, and the `MATCH SIMPLE`/`ON DELETE RESTRICT` reasoning in the migration's own comments
- `server/src/services/ledger-core/settingsService.ts` — `completeOnboarding`'s `catch` block, which turns the `23503` this constraint raises into a readable `ApiError(422, 'Cash account does not exist in this organization')` rather than leaking a raw Postgres error to the client
- `server/src/__tests__/ledger-core/settings.test.ts` — asserts the SQLSTATE `23503` directly against a raw `pool.query`, bypassing the service, matching the pattern `ledgerConstraints.test.ts` uses for the balance and immutability triggers

---

## Gotchas

- **The referenced side needs an explicit composite `UNIQUE`, even when one column is already a primary key.** `accounts.id` being unique doesn't make `(org_id, id)` a valid FK target on its own — Postgres needs that exact column pair declared unique.
- **`MATCH SIMPLE` (the default) treats any `NULL` in the FK's columns as an automatic pass**, not a violation — correct here (an unset cash account), but worth stating explicitly rather than discovering by surprise.
- **`ON DELETE SET NULL` on a composite key nulls every column in that key**, including ones that were never meant to change — check what else is in the FK's column list before reaching for `SET NULL` as the "obviously safe" option.
- **This protects referential integrity, not read-time authorization.** A composite FK stops a *bad row from being written*; it says nothing about which rows a given request is allowed to `SELECT`. The two are complementary, not substitutes — this table still needs an `org_id` predicate on every query, same as everywhere else in the codebase.
- **The redundant unique index is not free.** It's a second index on `accounts` that every insert/update maintains, for the sole purpose of satisfying one FK. Worth it here because the alternative is a class of tenant-isolation bug; not a pattern to reach for on every table without a real cross-tenant reference to protect.

---

## Interview Q&A

**Q: What extra guarantee does a composite foreign key give you that a single-column one doesn't?**
A: A single-column FK only guarantees the referenced id exists somewhere in the target table. A composite FK that includes the tenant column on both sides — `(org_id, x_id) REFERENCES t (org_id, id)` — guarantees the referenced row exists **and belongs to the same tenant** as the row pointing at it. Without that, "same organization" becomes something every write path has to remember to check in application code, which is a weaker guarantee than something the schema physically cannot violate.

**Q: Why do you need a separate `UNIQUE (org_id, id)` if `id` is already the primary key?**
A: A foreign key can only reference a column combination the database has already proven unique, and `id` being unique on its own doesn't make the *pair* `(org_id, id)` a declared unique target — Postgres won't infer that org_id is functionally redundant given id, even though it is. You have to spell out the composite uniqueness explicitly before anything can reference it as a two-column key, even though it's logically redundant information.

**Q: What does `MATCH SIMPLE` mean for a composite FK where one column is nullable, and why does it matter here?**
A: Under `MATCH SIMPLE`, which is Postgres's default, if *any* column in the FK's column set is `NULL`, the whole constraint is satisfied without checking the rest. For a nullable `cash_account_id`, that means "no cash account configured yet" — `cash_account_id = NULL` — passes immediately regardless of `org_id`, which is exactly the state you want to allow. `MATCH FULL` would instead require all-or-nothing nullability across the columns, which is the wrong shape here since `org_id` is never null on this table anyway.

**Q: Why is `ON DELETE SET NULL` a trap on a composite foreign key specifically?**
A: Because `SET NULL` nulls every column in the FK's local column list, not just the one you're conceptually "clearing." On a composite key like `(org_id, cash_account_id)`, deleting the referenced row would try to null both columns — including `org_id`, which is usually `NOT NULL` and often the table's own primary key. The delete would then fail on a constraint that looks unrelated to what you touched, which is a genuinely confusing thing to debug the first time you hit it. `RESTRICT` is the safer default when you're not certain every column in the key can tolerate being nulled.

**Q: Why not just enforce this with a service-layer check instead of a schema constraint?**
A: A service check works until a second code path exists — a batch script, a data migration, a different service, a future contributor who copies the pattern but forgets the check. Each of those has to independently remember to enforce "same org," and any one of them missing it reintroduces a cross-tenant leak. Pushing the invariant into the schema means it's enforced identically no matter what wrote the row, including a raw `psql` session — the bad state simply isn't representable, rather than merely being disallowed by convention.

**Q: Tell me about a time you had to choose between a database constraint and an application-level check for the same rule.**
A: LedgerCore's `cash_account_id` setting. The account-service pattern elsewhere in the codebase — checking that a re-parented account has the same organization *and* the same type as its new parent — is a service-level check, because "same type" genuinely can't be expressed as a foreign key; there's no constraint mechanism for "these two rows must agree on an arbitrary column." But "same organization" for `cash_account_id` *is* just an equality across two columns, which a composite FK expresses natively. I chose the constraint there and left the type check as a service check elsewhere, because the rule was: push an invariant into the schema whenever the schema can actually express it, and keep it in the service only when the schema genuinely can't.

---

## Follow-ups they'll dig into

- *"How would you protect a reference the database can't express as a simple equality?"* A service-level check plus a test asserting it — same-type parent re-parenting is exactly this case in the same codebase.
- *"What's the performance cost of the extra unique index?"* One more B-tree to maintain on every insert/update to `accounts` — worth it here for the tenant-isolation guarantee it buys, not something to add reflexively.
- *"Would row-level security replace this?"* No — RLS scopes what a session can *see*, not whether a written row's cross-reference is internally consistent. A `cash_account_id` pointing at an invisible-to-you row in another org is a worse bug (a dangling reference nobody can even inspect), not a fixed one.
- *"How would this generalize to a third table needing the same protection?"* Same shape — give the referenced table a composite `UNIQUE (org_id, id)` once, and every future same-tenant reference to it can use the same two-column FK pattern.

---

## See also

- [../architecture/multi-tenancy-row-level-scoping.md](../architecture/multi-tenancy-row-level-scoping.md) — the broader tenancy model this FK is one piece of; RLS as a backstop, and why `user_id` was the wrong boundary
- [recursive-ctes-and-hierarchies.md](recursive-ctes-and-hierarchies.md) — the sibling case where the invariant (same org, same type, acyclic) is *not* fully FK-expressible and stays a service-level check
- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — another example of pushing an invariant into the database rather than trusting application code alone
