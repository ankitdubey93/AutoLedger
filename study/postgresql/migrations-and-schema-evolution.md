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
- `server/src/__tests__/migrations.test.ts` — idempotency, the checksum guard, and every constraint the migration claims to create
- `server/package.json` — `migrate`, `db:reset`, and the `.sql` copy step in `build`

## Gotchas

- **The Docker volume outlives the code.** `docker compose down` does not remove `postgres-data`. When Phase 1 landed, the database still held the *deleted* pre-2026-07-30 build's `users`, `accounts` and `refresh_tokens` — so `CREATE TABLE IF NOT EXISTS refresh_tokens` silently no-op'd against the stale table and the next statement failed with `column "expires_at" does not exist`. `IF NOT EXISTS` checks the **name**, not the shape. Fix: `db:reset`, or `docker compose down -v`.
- **Never edit an applied migration** — now enforced by checksum rather than by memory.
- **`gen_random_uuid()` is built in since PG 13.** No `pgcrypto` extension; adding one is needless privilege.
- **`CREATE DATABASE` cannot run inside a transaction**, which is why the test `globalSetup` uses a bare `Client` against the `postgres` maintenance database rather than a pooled connection.
- **Sequential prefixes conflict across branches, on purpose.** Two people adding `002_` get a merge conflict instead of a silently misordered schema.

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

## Follow-ups they'll dig into

- *"What about `CREATE INDEX CONCURRENTLY`?"* Doesn't block writes, but can't run inside a transaction — so it needs a migration path outside the per-file `BEGIN`, and can leave an invalid index if it fails.
- *"How do you handle a migration that takes an hour?"* Batch it in the application, not the migration. A long `ALTER TABLE` holds `ACCESS EXCLUSIVE` and stops the world.
- *"Why no down-migrations?"* They destroy data and nobody runs them in production. Roll forward.
- *"How do you seed data?"* Reference data belongs in a migration; per-tenant data belongs in a service — which is why the chart of accounts is `accountService.seedDefaultChart`, not SQL.
- *"Timestamp vs sequential prefixes?"* Sequential forces a merge conflict when two branches collide, which is the honest outcome.

## See also

- [transactions-isolation-pooling.md](transactions-isolation-pooling.md) — the transaction semantics underneath
- [postgresql-foundations.md](postgresql-foundations.md) — MVCC and the catalogs
