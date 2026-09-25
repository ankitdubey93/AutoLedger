# Transactions, Isolation Levels & Connection Pooling

> A transaction is a property of a *session*, and a pool hands out sessions — which is the whole reason `pool.query` inside a `BEGIN` block silently corrupts your atomicity.

**Category:** PostgreSQL
**Introduced by:** Phase 1 — `db/connect.ts`, `authService.register`. Extended Phase 7 — the outbox drain's batch `SKIP LOCKED` claim. Extended Phase 28 — StockLedger's multi-row balance/serial locking: deterministic lock ordering, upsert-then-lock, and a `FULL JOIN` across a derived cache and its source ledger. Extended Phase 34a — `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` as per-row error recovery inside a batch bank-rule apply. Extended Phase 35a — `FOR SHARE` vs `FOR UPDATE` as a read-mapping/write-mapping locking protocol across accounting and inventory, and `pg_advisory_xact_lock` for serializing a concept (an org's whole true-up state) that has no row of its own.
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

### Locking several rows at once: deterministic ordering as the actual deadlock fix

Every earlier example here locks *one* row (a counter, a stock item in the rejected inventory-checkout example, a batch of outbox events claimed as an atomic set). StockLedger's `transfer` movement is the first place this codebase genuinely needs to lock **several distinct balance rows in one transaction** — a transfer debits a `(item, from-location)` balance and credits a `(item, to-location)` balance, both real rows that must be locked before either is written, so a concurrent transfer can't read a stale quantity on either side.

Locking two rows is exactly the shape that produces a classic deadlock: transaction A locks row 1 then wants row 2; transaction B — a transfer running in the *opposite* direction between the same two locations — locks row 2 then wants row 1. Each holds what the other needs; Postgres detects the cycle after `deadlock_timeout` (1s by default) and kills one with `40P01`. The fix the section above already names — "always acquire locks in a deterministic order" — is what `movementService.ts`'s `lockBalances` actually does: every call sorts its full set of `(itemId, locationId, lotId)` keys into one canonical order *before* issuing any `FOR UPDATE`, regardless of which balance the caller thinks of as "the from side" or "the to side." A transfer A→B and a transfer B→A both end up locking the same two rows in the same relative order — whichever sorts first, always first — so the cycle that produces a deadlock can never form. This isn't a mitigation that makes deadlocks *rare*; sorted locking makes the specific interleaving that causes them structurally unreachable, which is why `movementConcurrency.test.ts` runs two opposite-direction transfers concurrently, repeatedly, and asserts zero `40P01`s across the run rather than merely asserting the transfers eventually succeed.

### Upsert-then-lock: `SELECT ... FOR UPDATE` needs a row to already exist

`SELECT ... FOR UPDATE` can only lock a row that's already there — it is not a mechanism for creating one. A `receive` movement's very first unit for a given `(item, location, lot)` has no balance row yet, so there's nothing to `FOR UPDATE` against. `lockBalances` handles this the same way the invoice/item counters handle their own "first use" case (`gapless-numbering-and-counters.md`'s lazy-seed pattern): it first runs

```sql
INSERT INTO stock_balances (org_id, item_id, location_id, lot_id, quantity_milli, value_cents)
VALUES ($1, $2, $3, $4, 0, 0)
ON CONFLICT (org_id, item_id, location_id, lot_id) DO NOTHING
```

for every key in the sorted set — safe under concurrency because `ON CONFLICT DO NOTHING` never raises an error even if another transaction wins the insert race — and only then runs the sorted `SELECT ... FOR UPDATE` across all the keys, now guaranteed to find every row. "Upsert, then lock" rather than "lock, and insert if missing" specifically because Postgres has no `SELECT ... FOR UPDATE OR INSERT` primitive; you either prove the row exists first (this pattern) or you catch a locking failure and retry, and the upsert is strictly simpler once you already have `ON CONFLICT DO NOTHING` as a tool.

### Why `SERIALIZABLE` and per-row optimistic versioning were both rejected here

Two alternatives to pessimistic locking were considered and rejected for StockLedger's balance updates specifically:

- **`SERIALIZABLE` + retry.** Works well when the read set is hard to enumerate ahead of time. Here it's the opposite — a movement's affected balance rows are known exactly (they're computed from the request body) before any query runs, which is precisely the condition under which `FOR UPDATE` on a deterministic key set is simpler and cheaper: no abort-and-retry loop, no risk of a retry storm under contention, and the lock scope is provably minimal (exactly the rows this movement touches, nothing more).
- **Optimistic concurrency (a `version` column, `UPDATE ... WHERE version = $expected`).** Works well when contention is rare and a conflict should be surfaced to a human to resolve (an edit-conflict UI). A stock movement is the opposite case — two concurrent receipts against the same item/location are a completely normal, expected occurrence with no ambiguity about the correct outcome (both should succeed, and the balance should reflect both), not a conflict a person needs to adjudicate. Pessimistic locking lets both proceed correctly, serialized but never rejected; optimistic locking would make the second one fail and need an application-level retry loop to get the same result `FOR UPDATE` gives for free.

### `FULL JOIN` across a derived cache and its append-only source, and why raw `NULL` breaks it

`db/integrity.ts`'s `checkStockBalancesMatchMovements` needs to compare two independently-computed sets of rows — `stock_balances` (the cache) and a `GROUP BY` aggregate over `stock_movements` (Σ of the append-only source) — keyed by `(org_id, item_id, location_id, lot_id)`, and flag any key present in one set but not the other, or present in both with a different total. A `FULL JOIN` is the right shape (an `INNER JOIN` would silently hide a key that exists in only one side, exactly the bug this check exists to catch), but the natural key includes `lot_id`, which is nullable — and SQL's `a = b` is `NULL` (not `TRUE`) whenever either side is `NULL`, so a plain `ON a.lot_id = b.lot_id` fails to match two rows that both genuinely have "no lot," treating every lotless balance as if it existed on only one side. The fix folds the nullable column to a sentinel before comparing:

```sql
FULL JOIN movement_totals m
  ON b.org_id = m.org_id AND b.item_id = m.item_id AND b.location_id = m.location_id
 AND COALESCE(b.lot_id, '00000000-0000-0000-0000-000000000000')
   = COALESCE(m.lot_id, '00000000-0000-0000-0000-000000000000')
```

`COALESCE` substitutes a fixed, never-otherwise-used sentinel UUID whenever `lot_id` is `NULL`, so two lotless rows now compare sentinel-to-sentinel with ordinary equality, which *is* `TRUE` for equal values — turning a join condition that could never match `NULL` against `NULL` into one that can. This is the general fix for joining on a nullable key: `NULL` never participates in `=` truthfully, so any join (or `GROUP BY`, or `DISTINCT`) that needs nullable columns to behave as ordinary comparable values has to substitute a stand-in value first.

### `SAVEPOINT`: a real subtransaction, not just "try again"

The aborted-transaction-state section above (`current transaction is aborted, commands ignored until end of transaction block`) already establishes that one failed statement poisons everything after it in the same transaction. `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` is the mechanism that recovers from that *without* abandoning the whole transaction, and it is worth being precise about what it actually is underneath, because "just try again" undersells it.

`SAVEPOINT name` opens a genuine **subtransaction** inside the current one — Postgres assigns it its own internal subtransaction id (a "subxid"), nested under the top-level transaction's xid. From that point, any statement that fails aborts only the *subtransaction*, not the parent: `ROLLBACK TO SAVEPOINT name` discards every effect since that savepoint (including the failed statement's poisoned state) and returns the session to a healthy, further-statement-accepting condition, still inside the original transaction, with everything committed *before* the savepoint intact. `RELEASE SAVEPOINT name` is the mirror operation for the success path — it forgets the savepoint (you can no longer roll back to it) without touching anything it protected.

```sql
BEGIN;
INSERT INTO a ...;                    -- succeeds, stays in place either way
SAVEPOINT s;
INSERT INTO b ...;                    -- fails, e.g. a CHECK violation
ROLLBACK TO SAVEPOINT s;              -- undoes only the failed insert; session usable again
-- transaction is healthy here; the `a` insert from before the savepoint still stands
COMMIT;
```

This is genuinely a nested transaction, not a client-side retry loop pretending to be one — the abort/recover happens entirely inside PostgreSQL's own transaction machinery, visible to `EXPLAIN`/logging as real subtransaction ids, not as separate statements the application re-issued.

**The cost: `pg_subtrans` and the 64-subxid cache.** Each backend keeps a small in-memory cache (in `PGPROC`, sized `PGPROC_MAX_CACHED_SUBXIDS = 64` in the Postgres source) of the current transaction's own subtransaction ids, so that checking "is this row version visible to me" for a row written by one of *my own* earlier subtransactions is a fast in-memory array scan. Once a single transaction has opened more than 64 nested subtransactions (savepoints), that cache overflows, and every subsequent subxid-visibility check has to fall back to `pg_subtrans` — an on-disk (page-cached) lookup structure, mapping subxid → parent xid, one extra I/O-shaped lookup per check instead of an array scan. This doesn't fail or error; it's a **performance cliff**, not a correctness one — a transaction that opens thousands of savepoints in a tight loop gets measurably slower per savepoint once it crosses that 64 threshold, because every visibility check downstream now potentially touches `pg_subtrans`. (This 64-subxid cache and its `pg_subtrans` fallback is documented PostgreSQL internals behavior, verified against the 16.15 build this project runs on the `SELECT version()` output, not something independently re-derived from source for this note — flagging it as a fact to double-check if precision matters more than the general shape of the trade-off.)

The practical implication for this codebase: a `SAVEPOINT` used **once per row in a bounded loop that processes at most a few hundred candidates per call** (bank rules applying to a page of unmatched lines, capped well under 64 in the common case and only occasionally exceeding it on a large batch) is exactly the shape `SAVEPOINT` is good at — occasional, localized error recovery, not a hot path issuing thousands of savepoints per transaction. If a workload genuinely needed thousands of independent per-row recovery points in one transaction, the right fix is usually to *not* do it in one transaction at all (batch into several transactions), rather than accept the `pg_subtrans` fallback cost at scale.

### Why bank rules use one `SAVEPOINT` per line

`bankRuleService.applyRulesOnClient` (Phase 34a) applies a set of active rules to a batch of unmatched bank lines inside one caller-owned transaction (the import's own transaction, or the "apply to unmatched" endpoint's). For each line with a matching rule, it does:

```ts
await client.query('SAVEPOINT bank_rule_apply');
try {
  await bankMatchService.postJournalForTransactionOnClient(client, orgId, userId, line.id, { ... }, matched.id);
  await client.query('RELEASE SAVEPOINT bank_rule_apply');
  settledIds.push(line.id);
} catch (err) {
  if (err instanceof ApiError || pgErrorCode(err) === 'P0001') {
    await client.query('ROLLBACK TO SAVEPOINT bank_rule_apply');
    continue;   // this line stays UNMATCHED; the loop moves on to the next one
  }
  throw err;    // an unexpected error still poisons and propagates
}
```

The reason a savepoint is needed at all, rather than just catching the error in TypeScript: posting a journal entry can legitimately fail for a single line — the period covering that line's date might be closed, or a database-level trigger might reject the posting (`P0001`) — and that failure, uncaught at the SQL level, would poison the *entire* surrounding transaction per the aborted-transaction-state rule above. Without a savepoint, one bad line would silently prevent every other, otherwise-valid line in the same import from settling, because the whole transaction would already be unusable by the time the loop reached line two. The savepoint scopes the blast radius of one line's failure to exactly that line: `ROLLBACK TO SAVEPOINT` undoes only the attempted posting for that line, and the transaction — and every line already settled before it, whose work sits *before* the savepoint and is untouched by rolling back to it — remains healthy for the next iteration. This is precisely the `SAVEPOINT`-per-row shape the cost discussion above calls out as the right fit: a bounded loop (at most 1000 lines per `applyRulesToUnmatched` call), not an unbounded hot path.

### `FOR SHARE` vs `FOR UPDATE` as a read-mapping/write-mapping protocol (Phase 35a)

Every earlier locking example here is single-purpose: a row is locked because it's about to be written. Phase 35a's reclass machinery needed a second, weaker kind of lock for a genuinely different reason — not "I'm about to change this row," but "I need this row's *current* value to compute what to write elsewhere, and I need a guarantee nobody else changes it out from under me while I do."

`SELECT ... FOR SHARE` takes a **shared row lock**: any number of transactions can hold a `FOR SHARE` lock on the same row concurrently (readers don't block readers), but a `FOR SHARE` lock blocks a concurrent `UPDATE`/`DELETE`/`FOR UPDATE` on that row until the shared lock's transaction ends. It is the read-side half of a read-mapping/write-mapping protocol: `resolveInventoryPostingAccountsOnClient` and `resolveStockAccountsOnClient` (`server/src/services/accounting/settingsService.ts`, `itemService.ts`) take `FOR SHARE` on `ledger_settings`/`items` purely to *resolve* which GL account a product currently maps to — they have no intention of writing those rows, but they need Postgres to guarantee the mapping can't be edited by a concurrent transaction between the moment they read it and the moment the transaction that read it commits. `FOR UPDATE` is reserved for the transactions that are actually about to *change* the mapping (a `PATCH /items/:id` on `assetAccountId`, a settings default change) — those take the exclusive lock because two concurrent mapping changes on the same row genuinely must serialize, not just avoid seeing a torn read.

```sql
-- Read-mapping: "what account does this item resolve to right now?" (many readers, fine)
SELECT id, asset_account_id FROM items WHERE org_id = $1 AND id = ANY($2) ORDER BY id FOR SHARE;

-- Write-mapping: "I am about to change what account this item resolves to" (must serialize)
SELECT id FROM items WHERE org_id = $1 AND id = $2 FOR UPDATE;
```

**Why this, and not just always taking `FOR UPDATE`.** Every account-resolving read *could* take `FOR UPDATE` instead — it would still be correct, just needlessly pessimistic: a bill approval resolving a product's inventory account has no need to block another bill approval resolving the *same* product's account at the same time, since neither is changing the mapping. Using `FOR SHARE` for the read-only case lets many concurrent document postings against the same product proceed without contending on a lock neither of them needs exclusively, while still blocking the one operation (an actual mapping change) that would make a concurrently-read mapping stale mid-transaction.

**The actual deadlock-avoidance rule this protocol serves: resolve before you lock balances, always.** Phase 35a's real lock-ordering discipline (extending Phase 32's document-row → balances → number → journal order) is: document row `FOR UPDATE` → `items` rows (`FOR SHARE` to resolve, `FOR UPDATE` to change mapping, always `ORDER BY id`) → `ledger_settings` row (`FOR SHARE`/`FOR UPDATE` the same way) → `stock_balances` (one sorted `lockBalances` pass, per the deterministic-ordering rule above) → invoice/bill number → journal inserts. Every caller resolves which accounts it needs *before* it locks any balance row — never the reverse — because a caller that locked balances first and only then discovered (by resolving accounts) that it needed a lock on `items` or `ledger_settings` would be acquiring locks in an order some other transaction might acquire in reverse, recreating exactly the deadlock shape the sorted-`lockBalances` rule already solved for balances alone. This is proved, not just argued: `reclassConcurrency.test.ts` runs repeated iterations of `Promise.all([PATCH a product's assetAccountId, approve a bill for the same product])` — one path changing the mapping (`FOR UPDATE` on `items`), the other reading it to post stock (`FOR SHARE` on `items`, then locking balances) — and asserts zero `40P01`s across the run, plus a clean integrity check afterward.

### `pg_advisory_xact_lock`: locking a concept that has no row

Every lock discussed so far locks an actual row — a balance, a counter, an item. Sometimes the thing that needs to serialize has no natural row to hold a lock on at all. Two examples in this codebase:

- **`findOrCreateVendorByNameOnClient`** (Phase 19): `vendors.name` has no `UNIQUE` constraint, so two concurrent captures inventing the same brand-new vendor name could both pass a `SELECT` finding nothing and both `INSERT`, creating a duplicate vendor. There's no existing row for "this vendor name" to lock — the row doesn't exist yet, which is the whole problem.
- **`valuationService.trueUp`** (Phase 35a): closing a stock-vs-GL difference reads the account's current difference, compares it against the caller's `expectedDifferenceCents`, and posts a journal if they match. Two concurrent true-up requests for the same organization could both read the same stale difference and both post a correcting journal, double-fixing it. "The whole org's inventory reconciliation state" is not a row either.

`pg_advisory_xact_lock(key)` locks an application-chosen `bigint` key for the duration of the current transaction, released automatically on `COMMIT` or `ROLLBACK` — no explicit unlock call needed, no row to hold it. A second transaction calling `pg_advisory_xact_lock` with the *same* key blocks until the first one ends; a different key is entirely independent. Since the lock key has to be a `bigint` and the thing being serialized is naturally a string (an org id plus a purpose tag), both call sites hash a string into that key space rather than trying to invent a numeric id for a concept that has none:

```sql
-- vendorService: keyed on (org, normalized vendor name) — a 32-bit hash
SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2));

-- valuationService: keyed on (org, purpose) only — every true-up in the org
-- serializes against every other true-up in the org, not just same-account ones
SELECT pg_advisory_xact_lock(hashtextextended('stock_true_up:' || $1::text, 0));
```

`hashtext(text)` returns a 32-bit (`int4`) hash; `hashtextextended(text, seed bigint)` returns a full 64-bit (`int8`) hash and additionally takes a seed, which lets a string be hashed into a distinct space per "namespace" (`0` here is just a fixed constant, not org-specific) without string-concatenating a namespace prefix into the hashed text itself. Both are acceptable as the `bigint` argument `pg_advisory_xact_lock` wants; `hashtextextended`'s wider output space makes an accidental collision between two unrelated keys astronomically less likely than `hashtext`'s 32 bits would, which is the practical reason to prefer it for new call sites even though the 32-bit version was "good enough" for the Phase 19 case it was already serving. Note precisely what `trueUp`'s key covers: it is `(org)`, not `(org, account)` — every true-up attempt in an organization serializes against every other one, even on unrelated accounts, which is a deliberately coarser lock than the minimum necessary (a per-account key would allow two true-ups on *different* accounts to proceed concurrently) traded for simplicity, since true-ups are a rare, human-triggered corrective action, not a hot path where that extra serialization would be felt.

**Why an advisory lock instead of `SELECT ... FOR UPDATE` on some existing row, or a `UNIQUE` constraint plus `ON CONFLICT`.** A `UNIQUE` constraint (on `vendors.name`, say) would work for the vendor case specifically, but wasn't chosen because vendor-name uniqueness is a business rule this codebase doesn't otherwise want to enforce database-wide (two orgs, or even the same org, may have legitimate reasons the model doesn't currently forbid duplicate display names outside this one race). Locking some *other*, already-existing row as a stand-in (e.g. the organization's own row) would work too, but it borrows a lock whose real purpose is unrelated and would serialize this operation against every other thing that happens to lock the same stand-in row for its own reasons — an advisory lock's key space is deliberately unconnected to any table, so it only ever contends with other callers using that exact same conceptual key.

## Why we chose it here

| Decision | Reasoning |
|---|---|
| Explicit `BEGIN`/`COMMIT` on a checked-out client | Journal entry + its ledger lines must be all-or-nothing. Partial writes break the double-entry invariant permanently |
| `DELETE … RETURNING` to consume a refresh token | Read-then-write would let two concurrent refreshes both succeed. One statement makes the claim atomic — and turns "zero rows" into replay detection |
| `ON CONFLICT DO NOTHING` for slug allocation | A caught `23505` would abort the enclosing transaction, so retrying needs either this or a `SAVEPOINT` per attempt |
| READ COMMITTED (the default) for GL writes | The balance invariant is enforced in-application before insert, by CHECK constraints, and by a deferred constraint trigger at `COMMIT`; we're not doing read-then-write on contended rows |
| `SELECT ... FOR UPDATE` on a deterministically-sorted key set | Phase 28 — StockLedger's `lockBalances`/`lockSerials`. Read-then-write on genuinely hot rows (a movement's balance), where the affected key set is known exactly before any query runs — the case this codebase originally imagined for the now-dropped Inventory module, ultimately built by StockLedger instead. See [roadmap.md](../../docs/roadmap.md#dropped-from-scope) |
| `SERIALIZABLE` + retry for stock movements | Rejected — the read set is already known exactly (computed from the request), so it gets nothing over `FOR UPDATE` except an abort-and-retry loop and a risk of a retry storm under contention |
| Optimistic (`version` column) concurrency for stock movements | Rejected — two concurrent receipts against the same balance are both supposed to succeed, not conflict; optimistic locking would fail the second one and need an app-level retry to reach the outcome `FOR UPDATE` gives directly |
| Append-only ledgers over mutable counters | Sidesteps the lost-update class entirely — appending rows never contends the way `UPDATE counter` does. Current quantity is derived |
| `SAVEPOINT` per line inside `bankRuleService.applyRulesOnClient` | Phase 34a — one line's posting failure (a closed period, a trigger rejection) must not poison every other line's chance to settle in the same import transaction; caught in TypeScript alone wouldn't be enough, since the aborted-transaction state is set at the SQL level regardless of whether the client-side `catch` runs |

That last one is the deepest architectural point: choosing an append-only data model makes a whole category of concurrency bug structurally impossible rather than defended against.

## Where it lives in this codebase

Built in Phase 1:

- `server/src/services/authService.ts` — `register` (one transaction, `ON CONFLICT` slug loop), `rotateRefreshToken` (`DELETE … RETURNING`), `login`, `switchOrg`. Every query inside a transaction uses the checked-out `client`, never `pool`
- `server/src/db/migrate.ts` — one transaction per migration file, plus a session-level advisory lock
- `server/src/db/connect.ts` — the `Pool` singleton with its idle-client `error` listener

Phase 3:

- `server/src/services/accounting/journalService.ts` — the `BEGIN`/`COMMIT` block writing an entry and its lines together, every statement on the checked-out `client`
- `004_ledger-core_journals.sql` — the `DEFERRABLE INITIALLY DEFERRED` constraint trigger, the clearest example in the codebase of work that happens *at* `COMMIT` rather than before it (see [deferred-constraint-triggers.md](deferred-constraint-triggers.md))

Phase 7:

- `server/src/services/outboxService.ts` — `claimUnpublishedEvents`, the batch `SKIP LOCKED` claim above
- `server/src/services/webhookDeliveryService.ts` — `claimStaleDeliveries`, the same primitive applied to the stale-delivery sweep

Phase 28:

- `server/src/services/inventory/movementService.ts` — `lockBalances` (sort → upsert-seed via `ON CONFLICT DO NOTHING` → sorted `FOR UPDATE`), `lockSerials` (the same sorted-lock discipline applied to `stock_serials` rows by id)
- `server/src/__tests__/inventory/movementConcurrency.test.ts` — two opposite-direction transfers fired concurrently, repeatedly, asserting zero `40P01` deadlocks across the run
- `server/src/db/integrity.ts` — `checkStockBalancesMatchMovements`'s `COALESCE`-guarded `FULL JOIN`

Phase 34a:

- `server/src/services/accounting/bankRuleService.ts` — `applyRulesOnClient`'s per-line `SAVEPOINT bank_rule_apply` / `RELEASE` / `ROLLBACK TO SAVEPOINT`, scoping one bad line's posting failure to itself inside the import's own transaction

Phase 35a:

- `server/src/services/accounting/settingsService.ts` — `resolveInventoryPostingAccountsOnClient`'s `FOR SHARE` on `ledger_settings`
- `server/src/services/accounting/itemService.ts` — `resolveStockAccountsOnClient`'s `FOR SHARE` on `items`; `lockInventoryItemsOnClient`/`lockDefaultedInventoryItemsOnClient`'s `FOR UPDATE ... ORDER BY id`
- `server/src/services/accounting/inventoryAccountingService.ts` — the header docblock stating the full lock order this section documents
- `server/src/services/accounting/vendorService.ts` — `findOrCreateVendorByNameOnClient`'s `pg_advisory_xact_lock(hashtext(...))`, the earlier (Phase 19) advisory-lock precedent
- `server/src/services/inventory/valuationService.ts` — `trueUp`'s `pg_advisory_xact_lock(hashtextextended(...))`
- `server/src/__tests__/inventory/reclassConcurrency.test.ts` — the repeated product-account-change-vs-bill-approval race asserting zero `40P01`s

## Gotchas

- **`pool.query` inside a transaction block.** Silent partial commit. The single most damaging bug in this codebase's problem domain.
- **Not releasing a client in `finally`.** A thrown error before `release()` leaks a connection out of a pool of 10.
- **Assuming a `SELECT` repeats within a transaction.** It doesn't, at READ COMMITTED.
- **Long-running transactions.** They hold their snapshot, which blocks `VACUUM` from reclaiming dead tuples and causes table bloat. Never hold a transaction open across an external HTTP call.
- **`SERIALIZABLE` without a retry loop.** You've converted a correctness bug into an intermittent user-facing 500.
- **Money read as a string.** `row.debit_cents + 100` yields `"5000100"`. Parse at the service boundary.
- **Connection pooling in serverless.** Each instance opens its own pool; Postgres has a hard `max_connections` (default 100). PgBouncer in transaction mode is the usual answer — but it breaks session-scoped features like prepared statements and `SET LOCAL`.
- **Sorting only *some* of the locked keys.** Deterministic ordering only prevents deadlocks if *every* code path that locks more than one of these rows sorts the same way — a second function that locks the same two balance rows in request-arrival order instead of sorted order reintroduces the exact cycle the sort was meant to close. The discipline has to be centralized in one shared locking helper (`lockBalances`), not re-implemented ad hoc per movement type.
- **`ON CONFLICT DO NOTHING` seeding a row with zero quantity is not itself the operation.** It only guarantees a lockable row exists; the actual quantity/value change still happens in the subsequent `UPDATE` under the lock. Skipping the seed step (assuming the row already exists because "it usually does") reintroduces the exact race `FOR UPDATE` exists to close, on exactly the first-ever movement for a given key.
- **`COALESCE`'s sentinel must be a value that can never occur for real.** Using an empty string or `0` as the stand-in for a `NULL` UUID would be wrong if that value could ever legitimately appear in the column; a fixed all-zero UUID works here specifically because `lot_id` only ever holds real generated UUIDs or `NULL`, never the literal zero UUID.
- **A `SAVEPOINT` inside a loop that runs unbounded times is a latent performance bug, not a correctness one.** Below 64 nested subtransactions per top-level transaction it's essentially free; above that, every downstream visibility check for rows touched by one of your own subtransactions can fall back to an on-disk `pg_subtrans` lookup instead of an in-memory cache hit. A capped batch (bank rules apply to at most 1000 lines per call) stays in the cheap regime almost always; an unbounded per-row savepoint loop wouldn't.
- **Catching an error in TypeScript does not undo the aborted-transaction state at the SQL level.** A `try/catch` around a failed `client.query()` call stops the *exception* from propagating, but the session is still poisoned until something issues `ROLLBACK` (of the whole transaction) or `ROLLBACK TO SAVEPOINT` (of just the subtransaction) — the next query after a caught-but-unrolled-back failure still gets `current transaction is aborted`.
- **Resolving accounts *after* locking balances silently reintroduces a deadlock the `FOR SHARE`/`FOR UPDATE` protocol exists to prevent.** The rule is directional — resolve (accounts, `FOR SHARE`/`FOR UPDATE` as appropriate) before you lock (`stock_balances`, sorted) — not merely "lock everything you'll need." A new call site that looks up an item's current account mapping *after* it has already taken balance locks can end up acquiring `items`/`ledger_settings` locks in whatever order its own code happens to touch them, which is exactly the unsorted-acquisition shape the rest of this note's deadlock discussion warns about, just with a different pair of tables than the balance-row case.
- **An advisory lock key collision between two *unrelated* features is silent and easy to miss in review**, because nothing about the SQL itself says what the key means — it's just a number. Always hash a descriptive, namespaced string (`'stock_true_up:' || orgId`, not a bare `orgId`) rather than a raw id alone, specifically so two different features locking "the same" org for different reasons don't accidentally share a key and serialize against each other for no reason.
- **`pg_advisory_xact_lock` releases automatically at `COMMIT`/`ROLLBACK`, but only for the *transaction-scoped* variant used here.** The session-scoped sibling (`pg_advisory_lock`, no `_xact_`) requires an explicit `pg_advisory_unlock` and survives across multiple transactions on the same connection — using the wrong one in a pooled environment (where a "session" is handed back to the pool and reused by a completely different request) would leak a lock held by nobody the pool's next borrower knows about.

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

**Q: A transfer moves stock between two locations, so you need to lock two different balance rows in one transaction. What stops that from deadlocking against a transfer running in the opposite direction?**
A: Deterministic lock ordering. Both transfers know the full set of rows they need to lock before they lock anything, so instead of locking "from" then "to" in whatever order the request happened to name them, the code sorts the complete key set into one canonical order first and locks in that order every time. A transfer A→B and a transfer B→A then both lock the same two rows in the same relative order — whichever key sorts first is always locked first, by both transactions — so the circular wait that causes a deadlock (each holding what the other wants) can never form. It's not a fix that makes deadlocks less likely; it makes the specific interleaving that causes one unreachable, which is why the concurrency test asserts zero deadlocks across many repeated runs rather than just eventual success.

**Q: `SELECT ... FOR UPDATE` needs the row to already exist. What do you do when a receipt is the very first movement for an item at a location, and there's no balance row to lock yet?**
A: Seed it first with an idempotent insert — `INSERT ... VALUES (..., 0, 0) ON CONFLICT (...) DO NOTHING` — for every key you're about to need, before attempting any lock. `ON CONFLICT DO NOTHING` never raises even if a concurrent transaction wins the insert race, so after that statement every key is guaranteed to have a row, and the subsequent sorted `SELECT ... FOR UPDATE` is guaranteed to find something to lock. The actual quantity change still happens later, under the lock — the seed step's only job is making sure there's a row to lock in the first place.

**Q: Why not use SERIALIZABLE isolation for stock movements instead of explicit row locks?**
A: SERIALIZABLE earns its keep when the set of rows a transaction will touch is hard to know in advance — the database tracks read/write dependencies for you and aborts a transaction that would have caused an anomaly, so you don't have to enumerate what to lock. A stock movement doesn't have that problem: the exact balance rows it will touch are computable directly from the request before any query runs. Given a known key set, pessimistic locking is strictly simpler — no abort-and-retry loop, and the lock scope is provably minimal, exactly the rows this movement needs and nothing else.

**Q: What does `ROLLBACK TO SAVEPOINT` actually roll back, mechanically, and what does it cost?**
A: `SAVEPOINT` opens a real nested subtransaction with its own internal id, under the surrounding transaction's id. `ROLLBACK TO SAVEPOINT` discards every effect since that point — including whatever put the session into the aborted-transaction state — while leaving everything committed before the savepoint untouched, and leaving the session usable for more statements in the same transaction. It's not a client-side retry pretending to recover; the recovery happens inside Postgres's own transaction machinery. The cost is mostly invisible up to about 64 subtransactions per top-level transaction, because Postgres caches your own recent subtransaction ids in memory for fast visibility checks; past that cache size, checking whether a row your own earlier subtransaction touched is visible to you falls back to an on-disk lookup structure (`pg_subtrans`) instead of an array scan. It's a performance cliff, not a correctness one, and it only matters if you're opening savepoints by the thousands in one transaction rather than dozens.

**Q: When would you reach for `SAVEPOINT` instead of just letting one bad row fail the whole transaction?**
A: When the unit of "must succeed together" is smaller than the whole transaction — when one row's failure is expected to be a normal, survivable outcome for that one row, and every other row in the same transaction should still get its own independent chance to succeed. A batch bank-rule apply is exactly this shape: fifty lines might be settled in one import transaction, and a closed fiscal period rejecting line 12's posting shouldn't take lines 1 through 11's already-committed work down with it, nor should it prevent lines 13 through 50 from being tried. Wrap each row's risky work in its own savepoint, release it on success, roll back to it (and move on) on an expected failure, and only let a genuinely unexpected error propagate and abort the whole transaction.

**Q: What's the difference between `SELECT ... FOR SHARE` and `SELECT ... FOR UPDATE`, and when would you use the weaker one on purpose?**
A: `FOR UPDATE` takes an exclusive row lock — only one transaction can hold it, and it blocks every other locker including other `FOR UPDATE`/`FOR SHARE` attempts. `FOR SHARE` takes a shared lock — any number of transactions can hold it on the same row concurrently, but it still blocks a concurrent write (`UPDATE`/`DELETE`/`FOR UPDATE`) on that row. I use `FOR SHARE` when I need to *read* a value with a guarantee that it can't change underneath my transaction, but I have no intention of writing it myself — resolving which GL account an inventory item currently maps to before posting a document, for instance. Many bill approvals for different documents referencing the same product can all take that `FOR SHARE` lock and proceed concurrently, none of them blocking each other, because none of them is trying to change the mapping. The moment an operation actually needs to *change* the mapping, it takes `FOR UPDATE` instead, so that operation genuinely serializes against both other writers and any reader currently relying on the old value staying stable.

**Q: You have two tables that both need locking in a multi-step operation — how do you decide the order, and why does the order matter at all?**
A: The order has to be the *same* across every code path that ever needs to lock both, full stop — which table you lock first is almost arbitrary, but it must be picked once and never varied. If path A locks table X then table Y, and path B (running concurrently) locks Y then X, each can end up holding what the other wants: a textbook deadlock, and Postgres will pick one victim and kill it with a `40P01` after `deadlock_timeout`. The fix isn't retry logic, it's making the cycle structurally impossible: always acquire locks in one fixed, documented order. In this codebase that order is written down as a single sentence in a service's docblock — document row, then item rows, then settings, then stock balances (each of those internally sorted too, when there's more than one), then a number counter, then the journal — and every caller follows it, so two transactions racing for the same resources are always trying to acquire them in the same relative order and simply queue behind each other instead of deadlocking.

**Q: Why would you reach for `pg_advisory_xact_lock` instead of `SELECT ... FOR UPDATE`?**
A: `FOR UPDATE` locks a row that exists. Sometimes what needs to serialize isn't a row at all — a brand-new entity that doesn't exist yet (so two concurrent "find or create" calls could both find nothing and both create), or a whole cross-cutting operation with no single natural row to represent it (an organization's entire inventory-reconciliation state, in this codebase's case). `pg_advisory_xact_lock` takes an application-defined numeric key and blocks any other transaction requesting the *same* key, released automatically at commit or rollback — no table involved at all. Since the natural key is usually a string (an org id, a normalized name), I hash it into the `bigint` the function wants, and I always namespace the hashed string with a purpose tag rather than hashing a bare id, so two unrelated features that both happen to key off "this org" don't collide and serialize against each other for no reason.

## Follow-ups they'll dig into

- "How do you retry a serialization failure safely?" (Only if the transaction is side-effect-free outside the DB; cap attempts; add jitter. And the retry must re-run the *reads*, not just the writes.)
- "What's the difference between `FOR UPDATE` and `FOR NO KEY UPDATE`?" (The latter doesn't block FK checks that only need key stability — fewer false conflicts.)
- "How would you implement a job queue in Postgres?" (`SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` — consumers grab different rows without blocking each other.)
- "Why do long transactions cause table bloat?" (An open snapshot pins dead tuples; `VACUUM` can't reclaim rows still visible to any live snapshot.)
- "What if the set of rows to lock isn't known until you've already locked some of them?" (Deterministic ordering stops working the moment the key set can grow mid-transaction — that scenario needs either `SERIALIZABLE`+retry or a coarser lock covering the whole possible range up front.)
- "How would you prove your deadlock fix actually works, rather than just being lucky in testing?" (Fire the two opposite-order operations concurrently, repeatedly, under real load — a test that runs them once and passes proves almost nothing, since a deadlock is a race that may not trigger on a given run.)
- "What's the difference between rolling back to a savepoint and just catching the error in your application code?" (Catching the exception stops it from propagating in your language runtime, but the *database session* is still in the aborted-transaction state until something issues an actual `ROLLBACK` or `ROLLBACK TO SAVEPOINT` — the next query still fails otherwise.)
- "Could you use a savepoint instead of `ON CONFLICT DO NOTHING` for the slug-allocation retry loop earlier in this note?" (Yes, mechanically — savepoint before each `INSERT` attempt, roll back to it on `23505`, try the next candidate. `ON CONFLICT DO NOTHING` was preferred there because it raises no error at all, so there's nothing to catch or roll back; a savepoint is the right tool when the failure *can't* be avoided by choosing a different value up front, like a business-rule rejection on posting rather than a predictable uniqueness collision.)
- "Why not just always take `FOR UPDATE` everywhere and skip the `FOR SHARE` case entirely — isn't it simpler to have one lock mode?" (It would be correct, just needlessly serializing: every reader resolving an account mapping would then block every other reader doing the same, even though none of them is writing anything, for no correctness benefit — throughput drops under concurrent document posting against the same product for no reason.)
- "How would you prove the `FOR SHARE`/`FOR UPDATE` lock-ordering rule actually prevents the deadlock, rather than just happening not to trigger one in testing?" (Same answer as the balance-locking case above: fire the two opposite-shaped operations — a mapping change and a mapping read-then-write — concurrently, repeatedly, under real load, and assert zero `40P01`s across the run; a single passing run proves very little about a race.)
- "What if you picked the wrong advisory-lock key and two unrelated features collided?" (Silent over-serialization, not a correctness bug — two features that should be independent start blocking each other for no reason, which shows up as unexplained latency or timeouts under load, not as wrong data. Namespacing the hashed string, rather than hashing a bare id, is the practical defense.)

## See also

- [../architecture/multi-tenancy-row-level-scoping.md](../architecture/multi-tenancy-row-level-scoping.md)
- [../architecture/recurring-schedules-and-exactly-once-jobs.md](../architecture/recurring-schedules-and-exactly-once-jobs.md) — `FOR UPDATE SKIP LOCKED` reused as a single-row schedule claim, and the `DATE`-as-string discipline this note establishes
- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md)
- [../architecture/inventory-valuation-and-perpetual-stock.md](../architecture/inventory-valuation-and-perpetual-stock.md) — the append-only ledger + derived-cache design these locks protect, and the value-only reclass pair that locks accounts via this note's `FOR SHARE`/`FOR UPDATE` protocol
- [gapless-numbering-and-counters.md](gapless-numbering-and-counters.md) — the `ON CONFLICT DO NOTHING` lazy-seed idiom, first used for a counter row, reused here to seed a lockable balance row
- [subledger-reconciliation-and-aging.md](subledger-reconciliation-and-aging.md) — the control-account model `pg_advisory_xact_lock` serializes a correction against, in `valuationService.trueUp`
- `docs/guardrails.md` rules 5 and 7
