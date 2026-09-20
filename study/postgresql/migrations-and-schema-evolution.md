# Migrations & Schema Evolution

> PostgreSQL can roll back `CREATE TABLE`. That single fact is why a migration here either fully applies or leaves no trace, and why the tooling around it can be so much simpler than MySQL's.

**Category:** PostgreSQL
**Introduced by:** Phase 1 — the migration runner and `001_organizations_and_users.sql`
**Verified against:** PostgreSQL 16, Node 24.4.1, `pg` 8.22

---

## Mechanism

### Transactional DDL

In PostgreSQL, DDL is transactional. `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, `DROP` — all of them participate in `BEGIN`/`COMMIT` and roll back cleanly.

This works because the system catalogs (`pg_class`, `pg_attribute`, …) **are ordinary tables**, subject to the same MVCC rules as your data. Creating a table inserts a row into `pg_class`; rolling back marks that row's transaction aborted, so no snapshot ever sees it. There is no separate schema-metadata store to keep in sync.

MySQL (InnoDB) cannot do this — DDL causes an implicit commit, so a migration that fails on statement 4 of 6 leaves the first three applied and the database in a state no version of the schema describes. That is why migration tools in that ecosystem lean so hard on hand-written down-migrations and `repair` commands: they exist to clean up partial application, a problem PostgreSQL simply does not have.

So each file gets one transaction, and the runner needs no recovery logic:

```ts
await client.query('BEGIN');
await client.query(migration.sql);                          // whole file, one statement
await client.query('INSERT INTO schema_migrations …');
await client.query('COMMIT');
```

Note the ledger insert is *inside* the transaction. The schema change and the record of it commit together or not at all, so they cannot disagree.

### Idempotency, and what actually proves it

Every statement uses `IF NOT EXISTS` or `CREATE OR REPLACE`. But **re-running the runner does not test that** — the runner skips already-applied files, so a second run proves only that the ledger works.

The real test clears the ledger and re-applies the file against a database that already has every object:

```ts
await pool.query('DELETE FROM schema_migrations');
const { applied } = await runMigrations();
expect(applied).toEqual(['001_organizations_and_users.sql']);
```

Worth knowing where `IF NOT EXISTS` **does not exist**: `ALTER TABLE … ADD CONSTRAINT` has no such form. The idiom is a catalog check:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_line_nonzero') THEN
    ALTER TABLE ledger_lines ADD CONSTRAINT chk_line_nonzero CHECK (…);
  END IF;
END $$;
```

`CREATE OR REPLACE TRIGGER` requires **PostgreSQL 14+** (compose pins 16). Before that it was `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`. `CREATE OR REPLACE FUNCTION` has always existed, which is why the shared `set_updated_at()` is trivially idempotent.

### The checksum guard

Rule 13 says never edit an applied migration. The reason is that a checkout which already ran the old version never re-runs it, so two environments silently diverge — and nothing detects it until something breaks far away.

Discipline alone does not enforce that. The runner stores a SHA-256 of each file's contents and re-verifies on every run:

```
[migrate] failed: Migration 001_organizations_and_users.sql has changed since it was applied.
  recorded: 46e731be…
  current:  a3f19c02…
```

This is the single highest-value feature in the runner: it converts a convention people forget into a hard failure at the moment the mistake is made.

### Advisory locks — session vs transaction

Two servers booting simultaneously would both see the same pending migration and both try to apply it. An advisory lock serialises them — an application-defined mutex, held on a connection, with no relation to any row:

```ts
await client.query('SELECT pg_advisory_lock($1)', [KEY]);   // session-scoped
try { /* apply each file in its own transaction */ }
finally { await client.query('SELECT pg_advisory_unlock($1)', [KEY]); }
```

**Session-scoped, not `pg_advisory_xact_lock`.** The transaction-scoped variant releases at the next `COMMIT`, which would drop the lock after the first migration file. The lock must span all of them, so it lives on a dedicated checked-out client and is released in `finally` — a pooled connection returned while still holding an advisory lock would block every future runner.

### Locating the migrations directory

The runner has to find `migrations/` under three different runtimes: `tsx` (from `src/`), `node dist/`, and Vitest.

`import.meta.dirname` is the obvious choice and is **wrong here** — it is a Node-ESM property, and under Vitest the modules go through Vite's module runner, which populates `import.meta.url` but not reliably `dirname`. The migration test would fail while `npm run migrate` worked. Deriving it from the URL is correct everywhere:

```ts
const here = path.dirname(fileURLToPath(import.meta.url));
```

A related trap: `tsc` emits JavaScript and **does not copy `.sql` files**, so `dist/db/migrations/` comes out empty and the built server cannot migrate. The build script copies them explicitly with `fs.cpSync` — no new dependency needed on Node 22+.

### Zero-downtime: expand and contract

For a running system, a schema change and a code deploy cannot be simultaneous — old and new code overlap. The pattern is three deploys:

1. **Expand** — add the new column, nullable or defaulted. Old code ignores it.
2. **Migrate + dual-write** — new code writes both old and new; backfill existing rows in batches.
3. **Contract** — once nothing reads the old column, drop it.

Renaming a column in one step breaks every instance still running the old code. Under [guardrails rule 13](../../docs/guardrails.md) the contract step is a destructive change needing explicit sign-off.

Two facts that make this cheaper on PostgreSQL:

- **`ADD COLUMN … DEFAULT` is metadata-only since PG 11.** It used to rewrite the entire table; now the default is stored in the catalog and materialised on read. Adding a defaulted column to a huge table is instant.
- **Lock levels vary enormously.** `ADD COLUMN` takes a brief `ACCESS EXCLUSIVE`; `ALTER COLUMN TYPE` rewrites the table and holds it throughout. `CREATE INDEX` blocks writes — `CREATE INDEX CONCURRENTLY` does not, but cannot run inside a transaction, so it needs its own migration path outside the per-file `BEGIN`. Worth knowing before it bites in production.

### Renaming a table, in a new migration, without ever touching the old one

Rule 13 says an applied migration is frozen. That rule does not say a table's *name* is frozen — it says the *file that created it* is. When Phase 19.3 promoted Drive folder intake off AP-Flow's own tables (`ap_flow_drive_connections` → `integration_drive_connections`), the rename itself is `ALTER TABLE ... RENAME`, written in a brand-new migration (053), leaving 052's `CREATE TABLE ap_flow_drive_connections (...)` exactly as it was written and exactly as it was checksummed.

Two mechanical traps sit underneath that one-line description:

**`ALTER TABLE ... RENAME` has no `IF NOT EXISTS` on the target.** Every other idempotent form in this file's own idiom — `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` — has a form that makes re-running it a safe no-op. A rename has nothing equivalent; running it twice against the same database throws `relation "ap_flow_drive_connections" does not exist` the second time, because after the first run there's nothing left with the old name to rename. The idiom this file already uses for `ADD CONSTRAINT` (a catalog check via `to_regclass`/`pg_constraint` inside a `DO` block) extends directly:

```sql
DO $$
BEGIN
  IF to_regclass('public.ap_flow_drive_connections') IS NOT NULL
     AND to_regclass('public.integration_drive_connections') IS NULL THEN
    ALTER TABLE ap_flow_drive_connections RENAME TO integration_drive_connections;
  END IF;
END $$;
```

`to_regclass` returns `NULL` for a name that doesn't resolve to a relation, silently — unlike a bare `SELECT` against the table, which would throw if the table were already gone. The guard reads as "if the old name exists and the new one doesn't yet, do the rename" — true exactly once, ever, regardless of how many times the file runs. That is what "idempotent" actually has to mean for a statement with no built-in idempotent form: hand-roll the check the missing keyword would have done.

**PostgreSQL renames the table and nothing else.** Every constraint, every index, and every trigger the table carries keeps its **old** name after `RENAME TO` completes — `chk_ap_flow_drive_connections_state_complete` stays spelled that way, still attached to the newly-renamed table, forever, unless something explicitly renames it too. Leave that alone and `docs/schema.md` starts describing constraints under names that no longer match the table they're actually on — the exact kind of drift this project's own guardrails doc says killed the build that preceded this one. `ALTER TABLE ... RENAME CONSTRAINT ... TO ...` and `ALTER INDEX ... RENAME TO ...` are the (separately idempotent-unfriendly) fixes, one call per object, each needing the same existence-check treatment as the table rename itself.

A third, smaller pattern rides along with the same "additive, guarded" discipline: swapping a `CHECK` constraint's *definition* rather than its name. Postgres has no `ALTER CONSTRAINT ... USING (...)` for a `CHECK` the way some other clauses support an in-place rewrite — the idiom is drop-then-add, each half individually idempotent:

```sql
ALTER TABLE integration_drive_connections DROP CONSTRAINT IF EXISTS chk_..._connected_token;
ALTER TABLE integration_drive_connections ADD  CONSTRAINT chk_..._auth_payload CHECK (...);
```

`DROP CONSTRAINT IF EXISTS` tolerates the constraint already being gone (a second run of this same migration); the `ADD` is guarded separately if there's any chance of colliding with a constraint of the same new name already present. Two statements, two independent existence checks, rather than one statement trying to be both at once.

### Widening a CHECK to add a second legal shape, and the XOR idiom

Phase 6.1 needed the same drop-then-add swap for a different reason: not renaming the constraint, but widening what it accepts. `bank_transactions` previously had exactly one way to be `MATCHED` — a payment id set, everything else about the match state following from that. Adding a second way (a directly-posted journal entry, `matched_journal_entry_id`) meant the old CHECK — which hard-coded "payment id present" as part of "matched" — had to become "**exactly one** of these two columns is present," not "both may now be present" and not "either constraint, OR'd."

```sql
ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS chk_bank_txn_matched_fields;
ALTER TABLE bank_transactions ADD CONSTRAINT chk_bank_txn_matched_fields CHECK (
  (status = 'MATCHED' AND (matched_payment_id IS NULL) <> (matched_journal_entry_id IS NULL))
  OR (status <> 'MATCHED' AND matched_payment_id IS NULL AND matched_journal_entry_id IS NULL)
);
```

`(matched_payment_id IS NULL) <> (matched_journal_entry_id IS NULL)` is exclusive-or over two booleans — SQL has no `XOR` keyword, but `<>` between two `boolean` expressions is exactly that: true when they differ, which is true precisely when one is `NULL` and the other is not. The alternative shapes are both worse. A `match_type` discriminator column (`'payment'` / `'journal'`) plus two nullable FKs is more self-documenting but adds a column and a second thing that can disagree with the two match-target columns it's meant to describe — the CHECK still has to tie all three together, so the discriminator buys clarity at the cost of a third fact to keep consistent, not less to check. Enforcing "exactly one" only in the service layer and dropping the database-level CHECK entirely would be strictly worse: it is exactly the class of invariant guardrails rule 7 exists to keep out of "trust the application," proven by the raw-SQL constraint tests in `bankConstraints.test.ts` that insert directly against the pool and expect the database itself to refuse the row, service code never in the loop at all.

**`ADD CONSTRAINT` validates every existing row by default**, a full sequential scan under a lock that blocks writes for its duration — fine for a small table, a real concern for one with rows already in production. PostgreSQL 9.2+ offers an escape: `ADD CONSTRAINT ... CHECK (...) NOT VALID` skips that initial scan (existing rows are simply trusted, not checked), and a later `VALIDATE CONSTRAINT` — which takes a lighter lock and only requires that no concurrent writer produce a *new* violating row while it scans — closes the gap without blocking writes the whole time. This migration did not need that: `bank_transactions` had rows, but every one of them already satisfied the new CHECK (existing `MATCHED` rows all had a payment id and no journal-entry id, which is one of the two now-legal shapes), so a full immediate validation was cheap and there was no reason to leave the gap `NOT VALID` opens.

**A CHECK constraint can collide with an FK's own cascade action**, a trap this codebase hit once already (migration 056, unrelated table): an `ON DELETE SET NULL` foreign key nulls a column as its cascade side effect, and Postgres re-validates every CHECK against the row that cascade produces — so a CHECK that assumed "this column is only ever nulled by the application" can be violated by the database's own FK enforcement instead. `fk_bank_txn_journal_entry` here is `ON DELETE RESTRICT`, not `SET NULL`, specifically so this migration's own CHECK can't be caught by the same trap — a bank line's counterpart journal entry can never silently disappear out from under it the way that a duplicate-document pointer could.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `node-pg-migrate` / Flyway / Liquibase | Battle-tested, up/down, dry-run | Rejected — rule 14, and a runner this size is ~150 lines we fully understand |
| ORM migrations (Prisma, TypeORM) | Generated from a model | Rejected — **no ORM** (`docs/development.md`) |
| Timestamp prefixes (`20260830120000_…`) | No merge conflicts between branches | Rejected — sequential 3-digit prefixes make ordering obvious and *force* a conflict when two branches both add `002`, which is the conversation you want to have |
| **Hand-rolled runner + sequential `.sql`** | We own the edge cases | **Chosen** |
| Down-migrations | Reversible in principle | **Rejected.** A down-migration that drops a column destroys data, and in practice nobody runs them in production — you roll forward. `db:reset` covers the dev case honestly |

## Where it lives in this codebase

- `server/src/db/migrate.ts` — the runner: validation, advisory lock, ledger, checksums
- `server/src/db/reset.ts` — dev-only `DROP SCHEMA public CASCADE`, refuses under `NODE_ENV=production`
- `server/src/db/migrations/001_organizations_and_users.sql`
- `server/src/db/migrations/053_platform_drive_integration.sql` — the guarded `ALTER TABLE ... RENAME`, driven from `pg_constraint`/`pg_index` catalog loops so every auto-generated constraint and index name is renamed without being hand-listed and risking a guessed name being wrong
- `server/src/db/migrations/057_ledger-core_bank_line_journal.sql` — the XOR CHECK swap: `bank_transactions` gains a second legal "matched" shape without a discriminator column
- `server/src/db/migrations/056_ap-flow_duplicate_check_relax.sql` — the CHECK-vs-FK-cascade collision, on a different table
- `server/src/__tests__/migrations.test.ts` — idempotency, the checksum guard, and every constraint the migration claims to create
- `server/package.json` — `migrate`, `db:reset`, and the `.sql` copy step in `build`

## Gotchas

- **The Docker volume outlives the code.** `docker compose down` does not remove `postgres-data`. When Phase 1 landed, the database still held the *deleted* pre-2026-07-30 build's `users`, `accounts` and `refresh_tokens` — so `CREATE TABLE IF NOT EXISTS refresh_tokens` silently no-op'd against the stale table and the next statement failed with `column "expires_at" does not exist`. `IF NOT EXISTS` checks the **name**, not the shape. Fix: `db:reset`, or `docker compose down -v`.
- **Never edit an applied migration** — now enforced by checksum rather than by memory.
- **`gen_random_uuid()` is built in since PG 13.** No `pgcrypto` extension; adding one is needless privilege.
- **`CREATE DATABASE` cannot run inside a transaction**, which is why the test `globalSetup` uses a bare `Client` against the `postgres` maintenance database rather than a pooled connection.
- **Sequential prefixes conflict across branches, on purpose.** Two people adding `002_` get a merge conflict instead of a silently misordered schema.
- **A table rename leaves every constraint and index behind under its old name.** `ALTER TABLE x RENAME TO y` renames exactly the table — nothing attached to it is touched. Forgetting the follow-up `RENAME CONSTRAINT` / `ALTER INDEX ... RENAME` calls means the schema doc and the actual catalog silently disagree about names the moment anyone goes looking.
- **A destructive statement — including a rename — still needs explicit sign-off under rule 13**, even when it's additive in the sense of "no data is lost." The migration's own header comment records who signed off and when, so the decision is traceable in the file itself rather than only in a chat log or a PR description.

## Interview Q&A

**Q: What is transactional DDL and why does it matter?**
A: PostgreSQL lets `CREATE TABLE`, `ALTER TABLE` and friends participate in a transaction and roll back. It works because the system catalogs are ordinary MVCC tables — creating a table inserts a `pg_class` row, and aborting means no snapshot ever sees it. Practically, a migration that fails halfway leaves *nothing* behind, so my runner needs no recovery logic. MySQL implicitly commits on DDL, so a partial failure leaves a schema no version of your code describes — which is why tooling there needs down-migrations and repair commands.

**Q: How do you stop two servers running migrations at once?**
A: A session-level advisory lock — `pg_advisory_lock` — taken before reading the ledger and released in a `finally`. It's an application-defined mutex, unrelated to any row. It has to be session-scoped rather than `pg_advisory_xact_lock`, because the transaction-scoped one releases at the first COMMIT and each migration file gets its own transaction; the lock must span all of them. It also has to be on a dedicated client, since returning a connection to the pool while it still holds the lock would block every future runner.

**Q: You say migrations must be idempotent. How do you actually test that?**
A: Not by running the runner twice — it skips applied files, so that only tests the ledger. I truncate `schema_migrations` and re-run, which forces the SQL to execute again against a database that already has every object. That's what "additive and idempotent" actually demands. It caught the difference immediately.

**Q: How do you enforce "never edit an applied migration"?**
A: With a checksum rather than a rule. The runner stores a SHA-256 of each file and re-verifies every run; a changed file that's already applied throws with both hashes. It matters because a checkout that already ran the old version never re-runs it, so environments diverge silently and you find out somewhere unrelated. Turning it into a hard failure at the moment of the mistake is the whole point.

**Q: Walk me through a zero-downtime column rename.**
A: Three deploys, expand-and-contract. Add the new column nullable — old code ignores it. Then deploy code that writes both and reads the new one, and backfill existing rows in batches to avoid a long lock. Once nothing reads the old column, drop it. Doing it in one step breaks every instance still running old code during the rollout. On PostgreSQL, `ADD COLUMN … DEFAULT` has been metadata-only since 11, so the first step is instant even on a huge table.

**Q: Tell me about a migration that bit you.**
A: The first run of migration 001 failed with `column "expires_at" does not exist`, which made no sense for a table I was creating in the same file. The cause was that the Docker volume had outlived a full code reset — the project had been rebuilt from scratch months earlier, but `docker compose down` doesn't delete the volume, so the database still had the old build's `refresh_tokens` table. `CREATE TABLE IF NOT EXISTS` matches on the *name*, so it silently no-op'd against the stale table with a different shape, and the next statement failed. I dumped a backup, ran the reset, and it applied cleanly. The lesson I keep: `IF NOT EXISTS` checks existence, not agreement — and infrastructure state has its own lifecycle independent of your repository.

**Q: How do you rename a table under a rule that says an applied migration can never be edited?**
A: The rule protects the *file*, not the table's name forever — you write the rename in a brand-new migration, as `ALTER TABLE ... RENAME`, and leave the original `CREATE TABLE` migration untouched and still checksum-valid. Two things need explicit handling that are easy to miss. First, `RENAME` has no `IF NOT EXISTS` form, so making it idempotent means hand-rolling the guard with `to_regclass` — check the old name still resolves and the new one doesn't yet, inside a `DO` block, so a second run of the same migration file is a no-op instead of an error. Second, and the one that actually causes drift if you skip it: Postgres renames *only* the table. Every constraint, index and trigger it carries keeps its old name, still attached, forever, unless you rename those explicitly too — I drove that from a catalog query (`pg_constraint`/`pg_index` filtered by the old name pattern) rather than hand-listing names, because several of them were Postgres-auto-generated (`..._pkey`, `..._check`) and guessing one wrong fails the whole migration.

**Q: How do you widen a CHECK constraint to accept a second legal case, without breaking the rule that an applied migration can't be edited?**
A: Same drop-then-add idiom as a rename, in a new migration: `DROP CONSTRAINT IF EXISTS` followed by `ADD CONSTRAINT` with the same name but a wider definition. The interesting part is *how* it widens. A bank line used to be "matched" only by having a payment id set; I needed a second way — a directly-posted journal entry — without letting a row claim both or neither. That's exclusive-or, and SQL has no `XOR` keyword, but `<>` between two boolean expressions gives you exactly that: `(a IS NULL) <> (b IS NULL)` is true exactly when one is null and the other isn't. I rejected a `match_type` discriminator column for the same reason I'd reject denormalizing anything else that has to stay in sync with two other columns — it's a third fact that can disagree with the two it's describing, not less to check. And I rejected enforcing "exactly one" only in application code, full stop — that's precisely the invariant a database CHECK exists to guarantee regardless of which code path wrote the row, and I have raw-SQL tests that insert straight against the pool to prove the database catches it even when no service function is involved.

**Q: Does `ADD CONSTRAINT` block writes on a big table, and how would you avoid that?**
A: By default, yes — it validates every existing row under a lock that blocks writes for the duration, a full sequential scan. PostgreSQL gives you an escape: `ADD CONSTRAINT ... NOT VALID` skips that initial scan and trusts existing rows, then a separate `VALIDATE CONSTRAINT` does the check later under a much lighter lock that only has to guarantee no new violating row shows up mid-scan. I didn't need it for this particular constraint — the table had rows, but every one already satisfied the new, wider CHECK, so an immediate full validation was cheap — but it's the right tool the moment "every existing row already qualifies" isn't true, or the table is too large to lock even briefly.

## Follow-ups they'll dig into

- *"What about `CREATE INDEX CONCURRENTLY`?"* Doesn't block writes, but can't run inside a transaction — so it needs a migration path outside the per-file `BEGIN`, and can leave an invalid index if it fails.
- *"How do you handle a migration that takes an hour?"* Batch it in the application, not the migration. A long `ALTER TABLE` holds `ACCESS EXCLUSIVE` and stops the world.
- *"Why no down-migrations?"* They destroy data and nobody runs them in production. Roll forward.
- *"How do you seed data?"* Reference data belongs in a migration; per-tenant data belongs in a service — which is why the chart of accounts is `accountService.seedDefaultChart`, not SQL.
- *"Timestamp vs sequential prefixes?"* Sequential forces a merge conflict when two branches collide, which is the honest outcome.

## See also

- [transactions-isolation-pooling.md](transactions-isolation-pooling.md) — the transaction semantics underneath
- [postgresql-foundations.md](postgresql-foundations.md) — MVCC and the catalogs
