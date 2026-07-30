# PostgreSQL — Foundations

> An open-source object-relational database that forks a process per connection, never overwrites a row in place, and was designed from the start to be extended.

**Category:** PostgreSQL · Foundations
**Verified against:** PostgreSQL 16

---

## What it is

A relational database management system, descended from the POSTGRES project at Berkeley (1986), open-source since 1996. Three things distinguish it from the alternatives:

- **Strict ACID compliance** via MVCC and write-ahead logging — a committed transaction survives a power cut.
- **High SQL-standard conformance** plus a deep feature set: CTEs, window functions, `EXCLUDE` constraints, partial and expression indexes, `JSONB`, full-text search, table partitioning.
- **Extensibility as a founding design goal.** Custom types, operators, aggregate functions, index access methods, and procedural languages are all pluggable. This is why PostGIS, `pg_trgm`, TimescaleDB, and `pgvector` exist as extensions rather than forks.

"Object-relational" is mostly historical — it refers to table inheritance and a rich type system, not object storage.

## How it works

### Process architecture

The **postmaster** supervisor listens for connections and **forks a dedicated OS process per connection** (a "backend"). This is the single most consequential design decision in Postgres:

- Session state — the current transaction, `SET LOCAL` values, temp tables, prepared statements, advisory locks — lives in that process and is shared with nobody. This is exactly why `pool.query` escapes a transaction started on a different client.
- A connection costs a few MB and a fork. `max_connections` defaults to **100**. Opening connections per request does not scale, so a pooler is mandatory — `pg`'s in-process `Pool`, or PgBouncer in front of the database.

Alongside the backends run background processes: the **WAL writer**, **background writer**, **checkpointer**, **autovacuum launcher** and its workers, and the **archiver**. Shared memory holds `shared_buffers` (the page cache, default 128MB — usually tuned to ~25% of RAM), WAL buffers, and the lock tables.

### Storage

Tables are **heap files** split into **8KB pages**. A page holds tuples (row versions) plus a line pointer array. Values too large for a page go to **TOAST** — out-of-line, optionally compressed storage, kicking in around 2KB.

There is no clustered primary key as in MySQL/InnoDB: the heap is unordered and *every* index, including the primary key's, is a separate structure pointing at heap tuples. That's why Postgres has "index-only scans" as a distinct, notable optimisation — normally it must visit the heap to check visibility.

### WAL — why a committed transaction survives a crash

Before a data page is modified on disk, the change is written to the **write-ahead log** and `fsync`ed. Commit means "your WAL record is durably on disk," not "your table file is updated." Data pages are flushed lazily by the background writer and at **checkpoints**.

This one mechanism underpins crash recovery (replay WAL from the last checkpoint), streaming replication (ship WAL to a replica), and point-in-time recovery (replay WAL to a chosen moment).

### MVCC — why nothing is overwritten

Every tuple carries `xmin` (the transaction that created it) and `xmax` (the one that deleted it). An `UPDATE` **inserts a new version and marks the old one dead** rather than modifying in place. Each statement or transaction takes a *snapshot* determining which versions it can see.

Consequences worth knowing cold:

- **Readers never block writers, writers never block readers.** No read locks needed.
- **Dirty reads are impossible**, which is why `READ UNCOMMITTED` is silently treated as `READ COMMITTED`.
- **Dead tuples accumulate**, so `VACUUM` must reclaim them. `autovacuum` normally handles it; an update-heavy table or a long-open transaction (which pins its snapshot and prevents reclamation) causes **bloat**.
- An `UPDATE` touching one column rewrites the whole row and every index entry — unless HOT (heap-only tuple) optimisation applies, which requires no indexed column to change and free space on the same page.

### The query pipeline

1. **Parse** — SQL text to a raw parse tree (syntax only).
2. **Analyze / rewrite** — resolve names to catalog objects, expand views, apply rules.
3. **Plan / optimise** — the **cost-based planner** enumerates candidate plans and estimates each using table statistics gathered by `ANALYZE`. This is where Postgres is genuinely sophisticated.
4. **Execute** — walk the chosen plan tree, pulling rows node by node.

Plan node types you must recognise in `EXPLAIN` output: `Seq Scan`, `Index Scan`, `Index Only Scan`, `Bitmap Heap Scan`; and for joins `Nested Loop`, `Hash Join`, `Merge Join`. `EXPLAIN` shows estimates; `EXPLAIN ANALYZE` actually runs it and shows real rows and timings. **A large gap between estimated and actual row counts is the usual root cause of a bad plan** — stale statistics, or a correlation the planner can't model.

### Index types

| Type | For |
|---|---|
| **B-tree** | Default. Equality and range on ordered types; also serves `ORDER BY` |
| **Hash** | Equality only; rarely worth it over B-tree |
| **GIN** | Composite values where one row has many keys — `JSONB`, arrays, full-text, `pg_trgm` |
| **GiST** | Geometric, range, and nearest-neighbour queries; backs `EXCLUDE` constraints |
| **SP-GiST** | Space-partitioned data, non-balanced structures |
| **BRIN** | Very large, naturally-ordered tables (time-series); tiny index, coarse filtering |

Plus modifiers that matter more than people expect: **partial** indexes (`WHERE is_active`), **expression** indexes (`LOWER(email)` — how our case-insensitive uniqueness works), and **covering** indexes (`INCLUDE (...)`) to enable index-only scans.

## What it does best, and how

**Enforcing correctness.** Not just as a slogan — the mechanism is that Postgres lets you push invariants *below* the application, where no code path can bypass them. `CHECK` constraints, `UNIQUE` on expressions, `FOREIGN KEY` with `ON DELETE` behaviour, and `EXCLUDE USING GIST` (which can make overlapping date ranges physically impossible to insert) mean a bug in one service can't corrupt the data. Combined with real transactions and WAL durability, "the database is the source of truth" is literally enforceable.

**Complex analytical queries against transactional data.** The cost-based planner, window functions, recursive CTEs, and lateral joins let one query do work that would otherwise be N round-trips plus application-side assembly. A trial balance, a running ledger balance, or a multi-tier bill-of-materials resolves in a single statement.

**Absorbing new workloads without leaving the database.** Because extensions can add types, operators, *and index access methods*, Postgres has repeatedly swallowed use cases that used to need a separate system: `JSONB` + GIN for document storage, `pg_trgm` for fuzzy search, PostGIS for geospatial, `pgvector` for embeddings, TimescaleDB for time-series. One database with transactional guarantees across all of it beats several without.

## Where it's weak

- **Connection scaling.** Process-per-connection makes connections expensive. Serverless and high-fanout architectures need PgBouncer — which in transaction-pooling mode breaks session features like prepared statements and `SET LOCAL`.
- **Write scaling is vertical.** Read replicas are straightforward; multi-master needs external tooling. Sharding is not built in.
- **Update-heavy workloads bloat.** MVCC's cost. Needs `VACUUM` tuning and `fillfactor` awareness.
- **`VACUUM` and transaction ID wraparound** are real operational responsibilities at scale.
- **Defaults are conservative.** Out-of-the-box `shared_buffers` and `work_mem` assume a small machine.

## Why we chose it for AutoLedger

| Requirement | Why Postgres |
|---|---|
| Double-entry must never partially commit | Real transactions with WAL durability |
| Invariants that survive application bugs | `CHECK`, `EXCLUDE`, FK constraints below the app layer |
| Ledger reports, BOM trees, running balances | Window functions and `WITH RECURSIVE` in one query |
| Future modules need fuzzy search, JSONB forms, date-range exclusion | `pg_trgm`, `JSONB`+GIN, `btree_gist` — all extensions, no new datastore |
| Concurrency without overselling | `SELECT ... FOR UPDATE`, `SERIALIZABLE` when needed |

**Versus MySQL/InnoDB:** InnoDB is thread-per-connection so connections are cheaper, and its clustered-primary-key storage is faster for PK-range reads. Postgres wins on standards conformance, constraint expressiveness (MySQL only began enforcing `CHECK` in 8.0), index variety, partial/expression indexes, and the extension ecosystem. For a financial system where constraints *are* the product, that's decisive.

**Versus a document store:** the data is deeply relational — entries to lines to accounts to organizations — and the core invariant spans rows. Multi-row atomicity and cross-row constraints are the requirement, not an optimisation.

## Vocabulary that shows up in interviews

**MVCC** · **WAL** · **tuple** (a row version) · **heap** · **TOAST** · **bloat** · **`VACUUM`** / autovacuum · **snapshot** · **checkpoint** · **planner / cost estimate** · **statistics** (`ANALYZE`) · **index-only scan** · **HOT update** · **`xmin`/`xmax`** · **backend** (a connection's process)

## Interview Q&A

**Q: What makes PostgreSQL ACID-compliant — what's the actual mechanism?**
A: Four mechanisms, one per letter. Atomicity comes from transactions plus WAL: on crash, replay commits what was durably logged and discards the rest. Consistency comes from the constraint system — CHECK, FK, UNIQUE, EXCLUDE — enforced at the storage layer. Isolation comes from MVCC snapshots, so concurrent transactions see a consistent view without read locks. Durability comes from `fsync`ing the WAL record before acknowledging commit — the data pages themselves are written later, lazily. That last point is the one people miss: commit means the log is on disk, not the table.

**Q: What is MVCC and what does it cost you?**
A: Multi-version concurrency control. Rather than modifying rows in place, Postgres writes a new row version stamped with the transaction that created it, and visibility is decided per snapshot. The benefit is that readers and writers never block each other and dirty reads are structurally impossible. The cost is dead tuples: an `UPDATE` leaves the old version behind, so space must be reclaimed by `VACUUM`. If autovacuum can't keep up — or a long-running transaction pins an old snapshot so the rows are still potentially visible — you get table and index bloat, which shows up as queries slowly getting worse for no apparent reason.

**Q: Why is connection pooling mandatory with Postgres but less critical with MySQL?**
A: Postgres forks an OS process per connection; MySQL's InnoDB uses a thread per connection. A process is significantly more expensive to create and holds several MB, and `max_connections` defaults to 100. So connection churn is costly and the ceiling is low. The knock-on effect for application code is that a pooled connection *is* a session — transaction state, `SET LOCAL`, temp tables all live in that process — so any code assuming two queries share session state must hold the same checked-out client.

**Q: Walk me through what happens when you run a `SELECT`.**
A: The text is parsed into a raw tree for syntax. Then the analyzer resolves identifiers against the system catalogs and expands views. Then the cost-based planner enumerates plan candidates — which index or a sequential scan, which join algorithm and in what order — and estimates each using statistics collected by `ANALYZE`, picking the cheapest. Then the executor walks the plan tree pulling rows. When a query is unexpectedly slow, it's usually the planning stage: `EXPLAIN ANALYZE` will show estimated versus actual row counts, and a large divergence means the statistics are stale or the planner can't model a correlation between columns.

**Q: When would you use `JSONB` and when is it the wrong choice?**
A: Right when the shape is genuinely dynamic or per-tenant — our QMS inspection forms are customer-defined, so there's no fixed column set to model. It's wrong when you're avoiding schema design: you lose column-level constraints, foreign keys into the document, and honest statistics for the planner, and every read needs defensive parsing. Rule of thumb: if you find yourself indexing a specific key and querying it in every request, that key wanted to be a column. Also worth knowing `JSONB` normalises and reorders keys and strips duplicates, while `json` preserves the input text verbatim — `JSONB` is the one you index with GIN.

**Q: How do you decide what to index?**
A: Start from actual queries, not intuition — the columns in `WHERE`, `JOIN`, and `ORDER BY`. For composite indexes, column order matters enormously: put equality predicates first, then the range or sort column, because a B-tree can only use a prefix of its columns for seeking. In our schema every hot query filters on `org_id`, so it's the leading column of nearly every index — `(org_id, entry_date)`, never the reverse. Then look for the cheap wins Postgres offers specifically: a partial index when most rows are irrelevant (`WHERE is_active`), an expression index when you query a transformation (`LOWER(email)`), and `INCLUDE` columns to make a scan index-only. And verify with `EXPLAIN ANALYZE` rather than assuming — every index has a write cost, so an unused one is pure overhead.

## Follow-ups they'll dig into

- "What's transaction ID wraparound and why does it matter?" (32-bit XIDs; autovacuum must freeze old tuples or the database force-shuts-down to avoid corruption.)
- "Difference between `TRUNCATE` and `DELETE`?" (`TRUNCATE` is DDL — reclaims space immediately, no per-row MVCC versions, can't be filtered, takes an exclusive lock.)
- "How does streaming replication work, and what's synchronous vs asynchronous?" (Ship WAL; synchronous waits for replica acknowledgement before commit — durability versus latency.)
- "Why is `count(*)` slow on a big table?" (MVCC means visibility is per-snapshot, so there's no single correct maintained count; it must scan. `reltuples` for an estimate.)

## See also

- [transactions-isolation-pooling.md](transactions-isolation-pooling.md) — the deep dive on sessions and isolation
- `docs/schema.md` — our tables and constraints
