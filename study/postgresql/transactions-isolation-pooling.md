# Transactions, Isolation Levels & Connection Pooling

> A transaction is a property of a *session*, and a pool hands out sessions — which is the whole reason `pool.query` inside a `BEGIN` block silently corrupts your atomicity.

**Category:** PostgreSQL
**Introduced by:** Phase 1 — `db/connect.ts`, `authService.register`. Extended Phase 7 — the outbox drain's batch `SKIP LOCKED` claim
**Verified against:** PostgreSQL 16, `pg` (node-postgres) 8.x

---

## Mechanism

### One connection = one backend process = one session

Postgres forks a dedicated OS process per connection. Session state — the current transaction, `SET LOCAL` settings, temp tables, prepared statements, advisory locks — lives in that backend. Nothing is shared between connections.

`pg`'s `Pool` keeps a set of these connections (default `max: 10`) and hands one out per `pool.connect()`. **`pool.query()` grabs an arbitrary idle connection, runs one statement, and releases it.**

That single fact explains guardrail 5:

```ts
const client = await pool.connect();
await client.query('BEGIN');
await client.query('INSERT INTO journal_entries ...');  // ✅ in the transaction
await pool.query('INSERT INTO ledger_lines ...');       // ❌ DIFFERENT connection.
                                                        //    Different session.
                                                        //    Autocommitted immediately.
await client.query('ROLLBACK');
// journal_entries insert is rolled back. ledger_lines insert is NOT.
// You now have orphaned ledger lines and an unbalanced book.
```

The rollback only unwinds work on `client`'s session. The stray statement committed the instant it ran, because outside an explicit transaction Postgres wraps every statement in its own implicit one. There is no error, no warning — just silent partial writes. For a double-entry ledger this is the worst possible failure mode: the invariant that debits equal credits is broken in a way no constraint catches, because the constraint is *across rows*, not within one.

The rule that follows: once you check out a client, every query in that block uses `client`, and you `release()` it in a `finally` — a leaked client is permanently gone from a pool of 10, and ten leaks deadlock the app.

### MVCC and what isolation levels actually do

Postgres doesn't lock rows for reads. Every row version carries `xmin`/`xmax` (the transactions that created and deleted it), and each statement or transaction takes a **snapshot** deciding which versions are visible. Readers never block writers; writers never block readers.

| Level | Prevents | Still allows | Postgres notes |
|---|---|---|---|
| READ UNCOMMITTED | — | — | **Treated as READ COMMITTED.** Postgres cannot do dirty reads at all |
| **READ COMMITTED** | dirty reads | non-repeatable reads, phantoms, lost updates | **The default.** A *new snapshot per statement* |
| REPEATABLE READ | + non-repeatable reads, phantoms | write skew | Snapshot isolation: one snapshot for the whole transaction. Stronger than the SQL standard requires — phantoms are gone too |
| SERIALIZABLE | everything | — | Serializable Snapshot Isolation (SSI). Doesn't block; **aborts** offenders with SQLSTATE `40001` |

The critical, non-obvious point about READ COMMITTED: **each statement gets a fresh snapshot**. So inside one transaction, two identical `SELECT`s can return different data if another transaction committed in between. That's fine for most CRUD and catastrophic for read-then-write logic:

```sql
-- Two sessions, both READ COMMITTED, running concurrently:
SELECT quantity FROM stock WHERE item_id = $1;   -- both read 10
-- both decide 10 >= 8, so the sale is fine
UPDATE stock SET quantity = 2 WHERE item_id = $1; -- last writer wins
-- Sold 16 units of a 10-unit stock. This is the lost update problem.
```

### Three fixes, and when each applies

**1. `SELECT ... FOR UPDATE`** — pessimistic row lock. Takes an exclusive lock on the returned rows; a second `FOR UPDATE` on the same row blocks until the first transaction ends, then (in READ COMMITTED) re-reads the *latest* committed version.

```sql
BEGIN;
SELECT quantity FROM stock WHERE item_id = $1 FOR UPDATE;  -- second session waits here
UPDATE stock SET quantity = quantity - 8 WHERE item_id = $1;
COMMIT;
```

Lock strengths, weakest to strongest: `FOR KEY SHARE` → `FOR SHARE` → `FOR NO KEY UPDATE` → `FOR UPDATE`. Use `FOR NO KEY UPDATE` when you won't touch the primary key; it conflicts less with FK checks. `FOR UPDATE SKIP LOCKED` is the idiomatic way to build a queue-consumer; `NOWAIT` fails fast instead of waiting.

**2. Atomic in-statement arithmetic** — `SET quantity = quantity - 8` reads and writes in one statement, so no window exists. Combine with a CHECK constraint (`quantity >= 0`) and let the DB reject oversell. Simplest option when the logic fits in one statement.

**3. SERIALIZABLE + retry** — no locks, but the transaction may abort at commit with `40001`, and the caller *must* retry. Right choice when the read set is complex and hard to enumerate for locking; wrong choice if you have no retry loop.

### Deadlocks

Two transactions locking the same rows in opposite order deadlock. Postgres detects this after `deadlock_timeout` (default **1s**) and kills one with SQLSTATE `40P01`. Prevention is discipline, not configuration: **always acquire locks in a deterministic order** — e.g. sort item IDs before locking stock rows.

### `BIGINT` arrives as a string

`pg` returns `int8`/`BIGINT` and `NUMERIC` as **JavaScript strings**, not numbers. This is deliberate: `Number.MAX_SAFE_INTEGER` is 9,007,199,254,740,991 (2⁵³−1), and a 64-bit integer exceeds it, so silent precision loss would be possible. `int4` and `int2` come back as numbers.

Since every money column in this schema is `BIGINT` cents, **every money value read from the DB is a string in JS until parsed.** Parse deliberately in the service layer. You can override globally with `pg.types.setTypeParser(20, BigInt)` — but that makes values non-JSON-serialisable, so prefer explicit conversion.

### `DATE` arrives as a `Date`, and that is the bug

The mirror-image problem, and a more dangerous one because it fails silently and only for some users. `pg` parses `DATE` (OID 1082) into a JavaScript `Date` at **local midnight**:

```ts
// entry_date is DATE '2026-08-15'; process TZ is Asia/Kolkata (UTC+05:30)
row.entry_date                      // 2026-08-15T00:00:00 local
row.entry_date.toISOString()        // "2026-08-14T18:30:00.000Z"
  .slice(0, 10)                     // "2026-08-14"  ← a day early
```

Phase 3 shipped exactly this and the first journal-entry test caught it: posted `2026-08-15`, read back `2026-08-14`. West of UTC it would have moved forward instead, and at UTC+0 it would never reproduce at all — a bug that appears for some users and not others, on some machines and not others.

The deeper point is that **a `DATE` has no time and no timezone**, so representing it as an instant is lossy by definition; there is no timezone in which the conversion is meaningful. Keeping it a string is not a workaround, it is the correct representation:

```ts
types.setTypeParser(types.builtins.DATE, (value: string) => value);   // 'YYYY-MM-DD'
```

`TIMESTAMPTZ` is deliberately left alone — it genuinely *is* an instant, and parsing it to a `Date` is right. The distinction to carry: an accounting date is a calendar fact, a `created_at` is a moment in time, and conflating them is how period-end reporting quietly lands in the wrong month.

### A failed statement poisons the whole transaction

This one costs people an afternoon. In PostgreSQL, **any** error inside a transaction block puts it into an aborted state, and every subsequent statement fails with:

```
current transaction is aborted, commands ignored until end of transaction block
```

So the familiar "try the insert, catch the duplicate, try again" pattern **does not work inside a transaction** — the first `23505` has already poisoned the block, and the retry cannot run.

Phase 1's registration hits this directly: `organizations.slug` is globally unique and organization names collide constantly ("Acme"). Two ways out:

**`SAVEPOINT`** — a nested rollback point. `SAVEPOINT s; …; ROLLBACK TO s;` recovers the transaction to a known-good state, so a caught error is survivable. Correct, but it costs a round trip per attempt and clutters the code.

**`ON CONFLICT DO NOTHING`** — better here, because *no error is ever raised*:

```sql
INSERT INTO organizations (name, slug) VALUES ($1, $2)
ON CONFLICT (slug) DO NOTHING
RETURNING id
```

A conflict yields zero rows instead of an exception, so the transaction stays healthy and the loop simply tries the next candidate slug. Retrying inside the transaction becomes ordinary control flow.

Worth knowing that `ON CONFLICT DO UPDATE` (upsert) can deadlock under concurrency when multiple rows are inserted in different orders — same deterministic-ordering discipline as above.

### `DELETE … RETURNING` as an atomic claim

`RETURNING` is not only a convenience for getting the generated id back. It makes a read-and-claim a **single atomic statement**, which is a genuinely useful concurrency primitive.

Refresh-token rotation needs "find this token and consume it, exactly once". SELECT-then-DELETE races: both transactions read the row, both proceed. Instead:

```sql
DELETE FROM refresh_tokens WHERE token_hash = $1
RETURNING user_id, org_id, expires_at
```

Under READ COMMITTED the first transaction locks and deletes the row. The second blocks on that row lock, and when the first commits, re-evaluates its `WHERE` against the updated row version — which no longer exists — and returns **zero rows**. Exactly one winner, decided by the database.

And zero rows becomes *information*: a valid token signature with no matching row means it was already consumed, i.e. replayed. See [jwt-and-refresh-rotation.md](../security-auth/jwt-and-refresh-rotation.md).

The same shape works for a simple job queue: `DELETE FROM jobs WHERE id = (SELECT id FROM jobs ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.

### `SKIP LOCKED` as a queue-claim primitive, contrasted with `DELETE … RETURNING`

Phase 7's outbox drain needed the same "claim work exactly once" property as refresh-token rotation, but with a different shape: many rows claimed per pass, by potentially many concurrent workers, and the rows must **survive** the claim (a `webhook_deliveries` row is a durable record, not a one-shot token to be consumed and discarded). `DELETE … RETURNING` doesn't fit — deleting the row *is* the claim there, which is wrong when the row needs to still exist afterward for status tracking and audit purposes.

```sql
UPDATE outbox_events
   SET published_at = now()
 WHERE id IN (
         SELECT id FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
RETURNING id, org_id, app_slug, event_type, payload, created_at
```

`FOR UPDATE` inside the subquery takes an exclusive lock on the selected candidate rows; `SKIP LOCKED` changes what happens when another transaction already holds that lock — instead of blocking (plain `FOR UPDATE`'s behavior) or erroring (`NOWAIT`'s), the row is silently excluded from *this* query's result set. Two drain passes running concurrently — two worker processes, or an overlapping retry — therefore partition the unpublished backlog between them automatically: each gets whatever the other hasn't already locked, with zero coordination beyond what row-level locking already provides.

The outer `UPDATE` marks the claimed rows (`published_at = now()`) in the same statement that selects them, so "claimed" is a durable, queryable state (`WHERE published_at IS NULL` for the next pass) rather than a lock that vanishes the instant the transaction ends. `DELETE … RETURNING`'s one-shot consume-and-return shape suits a value used exactly once and then gone (a refresh token); `UPDATE ... SKIP LOCKED ... RETURNING` suits claiming a *batch* of rows that need to keep existing afterward — the general shape for "N workers, split this backlog, don't lose or duplicate any of it."

Full mechanism and the rest of the drain's design: [../architecture/transactional-outbox.md](../architecture/transactional-outbox.md).

## Why we chose it here

| Decision | Reasoning |
|---|---|
| Explicit `BEGIN`/`COMMIT` on a checked-out client | Journal entry + its ledger lines must be all-or-nothing. Partial writes break the double-entry invariant permanently |
| `DELETE … RETURNING` to consume a refresh token | Read-then-write would let two concurrent refreshes both succeed. One statement makes the claim atomic — and turns "zero rows" into replay detection |
| `ON CONFLICT DO NOTHING` for slug allocation | A caught `23505` would abort the enclosing transaction, so retrying needs either this or a `SAVEPOINT` per attempt |
| READ COMMITTED (the default) for GL writes | The balance invariant is enforced in-application before insert, by CHECK constraints, and by a deferred constraint trigger at `COMMIT`; we're not doing read-then-write on contended rows |
| `SELECT ... FOR UPDATE` | Not used anywhere. It was planned for inventory stock checkout, which is genuinely read-then-write on a hot row — but Inventory was dropped from scope, and no surviving app has that shape. See [roadmap.md](../../docs/roadmap.md#dropped-from-scope) |
| Append-only ledgers over mutable counters | Sidesteps the lost-update class entirely — appending rows never contends the way `UPDATE counter` does. Current quantity is derived |

That last one is the deepest architectural point: choosing an append-only data model makes a whole category of concurrency bug structurally impossible rather than defended against.

## Where it lives in this codebase

Built in Phase 1:

- `server/src/services/authService.ts` — `register` (one transaction, `ON CONFLICT` slug loop), `rotateRefreshToken` (`DELETE … RETURNING`), `login`, `switchOrg`. Every query inside a transaction uses the checked-out `client`, never `pool`
- `server/src/db/migrate.ts` — one transaction per migration file, plus a session-level advisory lock
- `server/src/db/connect.ts` — the `Pool` singleton with its idle-client `error` listener

Phase 3:

- `server/src/services/ledger-core/journalService.ts` — the `BEGIN`/`COMMIT` block writing an entry and its lines together, every statement on the checked-out `client`
- `004_ledger-core_journals.sql` — the `DEFERRABLE INITIALLY DEFERRED` constraint trigger, the clearest example in the codebase of work that happens *at* `COMMIT` rather than before it (see [deferred-constraint-triggers.md](deferred-constraint-triggers.md))

Phase 7:

- `server/src/services/outboxService.ts` — `claimUnpublishedEvents`, the batch `SKIP LOCKED` claim above
- `server/src/services/webhookDeliveryService.ts` — `claimStaleDeliveries`, the same primitive applied to the stale-delivery sweep

## Gotchas

- **`pool.query` inside a transaction block.** Silent partial commit. The single most damaging bug in this codebase's problem domain.
- **Not releasing a client in `finally`.** A thrown error before `release()` leaks a connection out of a pool of 10.
- **Assuming a `SELECT` repeats within a transaction.** It doesn't, at READ COMMITTED.
- **Long-running transactions.** They hold their snapshot, which blocks `VACUUM` from reclaiming dead tuples and causes table bloat. Never hold a transaction open across an external HTTP call.
- **`SERIALIZABLE` without a retry loop.** You've converted a correctness bug into an intermittent user-facing 500.
- **Money read as a string.** `row.debit_cents + 100` yields `"5000100"`. Parse at the service boundary.
- **Connection pooling in serverless.** Each instance opens its own pool; Postgres has a hard `max_connections` (default 100). PgBouncer in transaction mode is the usual answer — but it breaks session-scoped features like prepared statements and `SET LOCAL`.

## Interview Q&A

**Q: Tell me about a subtle bug you found in a driver's type handling.**
A: `node-postgres` parses a PostgreSQL `DATE` into a JavaScript `Date` at local midnight. My code then called `.toISOString().slice(0, 10)` to get `YYYY-MM-DD` back — which converts to UTC, so on my machine at UTC+05:30 an accounting date of the 15th came back as the 14th. A test caught it on the very first journal entry I posted. What makes it nasty is that it's timezone-dependent: west of UTC it shifts forward instead, and at UTC+0 it never reproduces — so it's the kind of thing that ships and then appears for some users and not others. The fix was a global type parser returning `DATE` as a raw string, and the reasoning matters more than the fix: a `DATE` has no time and no timezone, so turning it into an instant is lossy by definition — there's no timezone in which the conversion is meaningful. I left `TIMESTAMPTZ` parsing to a `Date`, because that genuinely is an instant. The general lesson is that an accounting date is a calendar fact and a `created_at` is a moment in time, and conflating the two is how a period-end report quietly lands in the wrong month.

**Q: What's the default isolation level in PostgreSQL, and what anomaly does it still permit?**
A: READ COMMITTED. It guarantees you never see uncommitted data, but it takes a fresh snapshot for *every statement*, so within one transaction the same query can return different rows if another transaction commits in between — non-repeatable reads and phantoms are both possible. The one that actually causes production bugs is the lost update: two transactions read the same value, both compute from it, and the second write silently overwrites the first.

**Q: How would you prevent overselling inventory under concurrent requests?**
A: Three viable approaches. First, `SELECT ... FOR UPDATE` on the stock row inside the transaction — pessimistic, the second request blocks until the first commits, then re-reads the current value. Second, do the arithmetic in the statement itself, `SET quantity = quantity - $1`, with a `CHECK (quantity >= 0)` so the database rejects an oversell atomically. Third, SERIALIZABLE with a retry loop on SQLSTATE 40001. For AutoLedger the choice is `FOR UPDATE`, because checkout is genuinely read-then-write with business rules in between. But the deeper design choice is that stock movements are an append-only ledger with quantity derived, which reduces how often we contend a single row at all.

**Q: Explain why `pool.query` inside a `BEGIN` block is a bug.**
A: A transaction is session state, and in Postgres a session is a connection — a dedicated backend process. `pool.connect()` gives you one specific connection; `pool.query()` grabs whatever is idle, which is almost certainly a different one. So a statement issued via `pool.query` runs outside your transaction on another session, and because Postgres implicitly wraps standalone statements, it commits immediately. Your later `ROLLBACK` unwinds the client's work and leaves that statement's effects in place. Silent partial write, no error. In a double-entry ledger that means a journal entry whose lines don't balance — an invariant violation no single-row constraint can catch.

**Q: Postgres has no dirty reads even at READ UNCOMMITTED. Why?**
A: MVCC. A writer creates a new row version stamped with its transaction ID rather than overwriting in place, and visibility is determined by snapshot rules — an uncommitted version simply isn't visible to other snapshots. There's no mechanism by which a reader *could* observe uncommitted data, so READ UNCOMMITTED is accepted for standards compliance and silently treated as READ COMMITTED.

**Q: What's write skew, and which isolation level does it need?**
A: Two transactions read an overlapping set of rows, each checks an invariant that spans them, and each writes a *different* row — so neither write conflicts, but together they break the invariant. The classic case is an on-call rota where two people each check "someone else is on call" and both remove themselves. Snapshot isolation (Postgres REPEATABLE READ) allows it, because it only detects write-write conflicts on the same row. You need SERIALIZABLE, which tracks read dependencies and aborts one transaction, or you materialise the conflict by locking a row that represents the invariant.

**Q: Why does node-postgres return `BIGINT` as a string?**
A: Because JavaScript numbers are IEEE 754 doubles, exactly representing integers only up to 2⁵³−1 — about 9.007×10¹⁵. A 64-bit integer can exceed that, so parsing into a `number` risks silent precision loss. Returning a string is lossless and lets the application decide. It matters a lot for us: every money column is `BIGINT` cents, so amounts arrive as strings and must be parsed explicitly in the service layer. Concatenating instead of adding is a real bug that unit tests need to cover.

**Q: Tell me about a time you had to reason about transaction boundaries.**
A: The rule I enforce on AutoLedger came from a bug pattern in its predecessor: a service opened a transaction, wrote its rows, committed, and then ran a follow-up query via `pool.query` for a side effect, with the error swallowed as non-fatal. It worked, but it was a template waiting to be copied wrong — the next person to add a statement inside the transaction block would reach for `pool.query` too and get a silent partial write. So the guardrail is two-part: every query inside a transaction uses the checked-out client, and no post-`COMMIT` follow-up work in the same function at all. If something must happen after commit, it becomes a queued job with real retry semantics instead of a fire-and-forget with a swallowed error.

## Follow-ups they'll dig into

- "How do you retry a serialization failure safely?" (Only if the transaction is side-effect-free outside the DB; cap attempts; add jitter. And the retry must re-run the *reads*, not just the writes.)
- "What's the difference between `FOR UPDATE` and `FOR NO KEY UPDATE`?" (The latter doesn't block FK checks that only need key stability — fewer false conflicts.)
- "How would you implement a job queue in Postgres?" (`SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` — consumers grab different rows without blocking each other.)
- "Why do long transactions cause table bloat?" (An open snapshot pins dead tuples; `VACUUM` can't reclaim rows still visible to any live snapshot.)

## See also

- [../architecture/multi-tenancy-row-level-scoping.md](../architecture/multi-tenancy-row-level-scoping.md)
- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md)
- `docs/guardrails.md` rules 5 and 7
