# Idempotent Ingestion and Dedupe Hashes

> "Import this statement" is a button someone will click twice — a slow upload, an impatient double-click, a retried request after a flaky connection. The system's job is to make the second click a safe no-op, not a duplicated set of transactions.

**Category:** PostgreSQL
**Introduced by:** Phase 6 — LedgerCore bank statement import, the roadmap's stated acceptance criterion: "the same statement imported twice yields one set of rows."

---

## Mechanism

### Why a natural key doesn't work

The obvious dedupe key for a bank line is `(date, amount, description)` — surely no two transactions share all three? In practice, they routinely do: a subscription charged twice a month at the identical amount, two identical £5 coffee purchases on the same card on the same day, a payroll run crediting two employees the exact same net amount on the exact same date with an identical generic description like `"PAYROLL"`. A natural key built from the visible fields of a single row cannot distinguish "the same transaction, re-imported" from "two genuinely different transactions that happen to look alike" — both produce an identical tuple.

### Content-addressed hashing, scoped per tenant

`bank_transactions.dedupe_hash` is a SHA-256 hash of a composite string built from `org_id`, `account_id`, the transaction's date, amount, normalized description, external reference, and — critically — an **occurrence ordinal** (below). The column is `CHAR(64)` (a hex-encoded digest, fixed width, so the column type itself documents what it holds), and the actual dedupe guarantee lives in a database constraint, not application logic:

```sql
CONSTRAINT ux_bank_transactions_dedupe UNIQUE (org_id, dedupe_hash)
```

The unique index is scoped to `(org_id, dedupe_hash)`, not `dedupe_hash` alone — two different organizations can each import a statement whose lines happen to hash identically (extremely unlikely with SHA-256's collision resistance, but the scoping is really about tenancy, not collision probability: even a coincidental hash match across two unrelated organizations must never look like a duplicate of a different tenant's data). This is the same discipline as every other tenant-scoped `UNIQUE` constraint in this schema — see [composite-foreign-keys-for-tenancy.md](composite-foreign-keys-for-tenancy.md).

### `INSERT ... ON CONFLICT DO NOTHING RETURNING id` as an atomic dedupe-and-count

Re-importing the same file needs to do three things at once: insert every row that's genuinely new, silently skip every row that's already present, and report back how many of each happened — without a separate `SELECT` to check for existence first (a check-then-insert race, the same class of bug [exclusion-constraints-and-gist.md](exclusion-constraints-and-gist.md) closes for fiscal periods). One statement does all three:

```sql
INSERT INTO bank_transactions (org_id, import_id, account_id, txn_date, description, external_reference,
                                currency_code, amount_cents, dedupe_hash)
SELECT $1, $2, $3, v.txn_date, v.description, v.external_reference, $4, v.amount_cents, v.dedupe_hash
  FROM unnest($5::date[], $6::text[], $7::text[], $8::bigint[], $9::text[])
       AS v(txn_date, description, external_reference, amount_cents, dedupe_hash)
ON CONFLICT (org_id, dedupe_hash) DO NOTHING
RETURNING id
```

`ON CONFLICT DO NOTHING` means a row whose `(org_id, dedupe_hash)` already exists is silently skipped rather than raising `23505` and aborting the whole batch — the entire statement succeeds regardless of how many of the batch's rows are duplicates. `RETURNING id` then hands back exactly the rows that were *actually inserted*; `insertedRows.length` is the true "how many new" count, and `validRows.length - insertedRows.length` is the duplicate count, both derived from one round trip with no follow-up query needed. This is the same `unnest(...)` batch-insert idiom `paymentService`'s allocation insert already uses, applied here for its `ON CONFLICT`-plus-`RETURNING` combination rather than for its batching alone.

### The identical-rows-within-one-file problem, and the occurrence-ordinal fix

A naive hash of `(org_id, account_id, date, amount, description, reference)` alone has a subtler bug than the natural-key problem above: if a single statement genuinely contains two byte-identical lines — the coffee-shop-twice-in-one-day case — both rows hash to the *same* value, and the second `INSERT` collides with the first **within the same batch**, silently losing a real transaction that was never a duplicate of anything, just a coincidence. The fix folds an **occurrence ordinal** into the hash input: while parsing a file, `bankImportService` counts how many earlier rows *in this same file* share the identical tuple, and that count (0, 1, 2, …) becomes part of what gets hashed. The first of two identical lines hashes with ordinal `0`, the second with ordinal `1` — different hashes, both survive the insert. Re-importing the same file reproduces the same ordinals in the same order (parsing is deterministic), so both lines collide with their true earlier counterparts on the second import and both are correctly recognized as duplicates. The ordinal is what makes "gracefully handle identical rows within one file" and "correctly dedupe on re-import" simultaneously true — solving either alone is easy; solving both with the same hash function is the actual problem.

### Why the hash is computed server-side, never client-supplied

Nothing about `dedupe_hash` is accepted from the request body — `bankSchema.ts`'s `importStatementSchema` doesn't even have a field for it. A client-supplied hash would let a caller forge collisions (deliberately suppress an import by hash-colliding with existing rows) or, just as bad, forge *non*-collisions (defeat the dedupe guarantee entirely by sending a fresh random hash for what is actually the same statement). The hash is a property the server derives from data it already trusts — the parsed row plus the tenant and account it's importing into — never a value the client asserts.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Natural key `(date, amount, description)`, `UNIQUE` constraint on those columns directly | No hashing needed, simple to reason about | Rejected — routinely collides on genuinely distinct transactions (identical amount, date, and generic description is common, not rare) |
| Check-then-insert (`SELECT` for existence, then `INSERT` if absent) | Straightforward application logic | Rejected — the classic check-then-write race: two concurrent imports of the same file could both pass the check before either commits, same failure mode `EXCLUDE`/`ON CONFLICT` exist to close everywhere else in this codebase |
| Client-supplied idempotency key (a `dedupe_hash` field in the request) | Simpler server code | Rejected — hands the dedupe guarantee's correctness to the client, which can forge or omit it; the server must derive it from data it already trusts |
| **Server-computed SHA-256 hash, folding in an occurrence ordinal, enforced by a tenant-scoped `UNIQUE` constraint + `ON CONFLICT DO NOTHING`** | Requires the ordinal-counting pass while parsing | **Chosen** — race-free (the constraint, not application timing, is the guarantee), correctly handles genuinely-identical same-file rows, and the dedupe/count logic is one SQL round trip |

---

## Where it lives in this codebase

- `server/src/db/migrations/019_ledger-core_bank_reconciliation.sql` — `bank_transactions.dedupe_hash CHAR(64)`, `CONSTRAINT ux_bank_transactions_dedupe UNIQUE (org_id, dedupe_hash)`
- `server/src/services/ledger-core/bankImportService.ts` — `computeDedupeHashes` (the occurrence-ordinal counting), the `unnest(...) ... ON CONFLICT DO NOTHING RETURNING id` batch insert
- `server/src/__tests__/ledger-core/bankImports.test.ts` — `'the same statement imported twice yields one set of rows'` (the roadmap's own acceptance criterion, as a named test) and `'two identical lines in one file both survive, and re-import still dedupes'`
- `server/src/__tests__/ledger-core/bankConstraints.test.ts` — the raw-SQL proof that the constraint holds regardless of what wrote the row, and that it's scoped per-tenant (`'allows the same dedupe_hash in a different organization'`)

---

## Gotchas

- **Without the occurrence ordinal, a batch containing two genuinely identical rows silently loses one of them** — this is easy to miss in testing if your fixtures never happen to contain a true duplicate line, which is exactly the kind of edge case a deliberately-constructed test (rather than incidental coverage) has to force.
- **`ON CONFLICT DO NOTHING` swallows the conflict silently — there is no way to distinguish "already imported, skip" from "some other constraint would have failed" from the `RETURNING` clause alone.** Any other `CHECK`/`NOT NULL` violation in the same batch still aborts the whole statement normally; `ON CONFLICT` only intercepts the one named constraint.
- **The unique index is on `(org_id, dedupe_hash)`, not `dedupe_hash` alone** — dropping the `org_id` component would be a correctness bug disguised as an optimization (a smaller index), since it would make a coincidental cross-tenant hash collision look like a duplicate row rather than two unrelated organizations' genuinely distinct data.
- **Parsing must be deterministic for the ordinal scheme to work at all** — if row order or the tuple used to compute the ordinal ever became nondeterministic between two imports of byte-identical file content, the second import's ordinals wouldn't line up with the first's, and rows that should dedupe would look new instead.

---

## Interview Q&A

**Q: Why not just use `(date, amount, description)` as a natural unique key for a bank transaction?**
A: Because those three fields collide far more often than intuition suggests — a subscription charged the same amount monthly, two identical small purchases on the same day, a payroll run crediting several people the same net amount with a generic description. A natural key built only from a single row's visible fields can't tell "this is the same transaction, re-imported" apart from "this is a different transaction that happens to look the same," and conflating the two either rejects legitimate distinct transactions or fails to catch real duplicates.

**Q: How do you make an import idempotent — safe to run twice with the same file — without a separate existence check before each insert?**
A: A single `INSERT ... ON CONFLICT (org_id, dedupe_hash) DO NOTHING RETURNING id`, batched via `unnest(...)` for every row in the file at once. The database's unique constraint is the actual guarantee — a check-then-insert in application code has the same race every "check, then act" pattern has: two concurrent imports could both pass the check before either commits. `ON CONFLICT DO NOTHING` lets the whole batch succeed regardless of how many rows are duplicates, and `RETURNING id` reports back exactly which rows were newly inserted, giving you the "how many were new vs. duplicate" count from the same round trip.

**Q: What's the bug in hashing `(date, amount, description)` alone if a statement contains two genuinely identical transactions?**
A: Both rows would hash to the same value, and within the same import batch the second row's insert collides with the first — `ON CONFLICT DO NOTHING` silently drops it, even though it was never actually a duplicate of anything, just a coincidence. The fix is to fold an occurrence ordinal into the hash: count how many earlier rows in this same file share the identical tuple, and hash that count in too, so the first occurrence and the second occurrence produce different hashes and both survive.

**Q: Why does the occurrence-ordinal fix still correctly dedupe on re-import, rather than treating every re-imported row as new?**
A: Because parsing the same file content twice produces the same rows in the same order, so the ordinal-counting pass reproduces identical ordinals on both imports — the first line of the pair gets ordinal 0 both times, the second gets ordinal 1 both times. Since the hash inputs match exactly on the second import, both rows collide with their true earlier counterparts and both are correctly recognized as duplicates, not just one of them.

**Q: Why compute the dedupe hash server-side instead of accepting one from the client?**
A: A client-supplied hash hands the correctness of the dedupe guarantee to something outside the server's control — a caller could forge a hash to deliberately collide with (and suppress) a legitimate import, or just as easily send a fresh value for what is actually the same statement and defeat deduplication entirely. The hash has to be derived from data the server already trusts (the parsed row, the tenant, the account), the same way you'd never trust a client to assert its own row's primary key is unique.

---

## Follow-ups they'll dig into

- *"What if the same statement is imported into two different accounts by mistake?"* The hash includes `account_id`, so the same transaction imported against a different account produces a different hash and is not deduped against the first import — this is treated as the user's mistake to notice and undo, not something the dedupe mechanism can or should silently catch, since a genuine transfer between two of the organization's own accounts really would appear on two different account statements.
- *"How would this scale to millions of bank lines per organization?"* The `UNIQUE (org_id, dedupe_hash)` constraint is backed by a B-tree index, so the lookup during `ON CONFLICT` checking stays `O(log n)` regardless of table size — the real scaling concern would be the batch `INSERT`'s parameter array size for a single enormous statement, which is why `MAX_CSV_CHARS` caps the input file size well before that becomes a problem.
- *"Could you use the database's own `md5()` or a `GENERATED ALWAYS AS` computed column instead of hashing in application code?"* You could compute the hash in SQL, but the occurrence-ordinal counting needs a stateful pass over the *whole file's* rows in order (tracking how many times each tuple has been seen so far) — that's naturally an application-level fold over an ordered sequence, not something a per-row `GENERATED` column expression (which sees only one row at a time, with no memory of prior rows) can express.

---

## See also

- [../node-express/parsing-untrusted-csv.md](../node-express/parsing-untrusted-csv.md) — where the rows being hashed and deduplicated come from
- [composite-foreign-keys-for-tenancy.md](composite-foreign-keys-for-tenancy.md) — the same "scope the uniqueness constraint by tenant, not globally" discipline applied elsewhere
- [exclusion-constraints-and-gist.md](exclusion-constraints-and-gist.md) — the sibling "close the check-then-write race with a database constraint instead of application timing" story, for a different invariant (no overlapping fiscal periods)
- [gapless-numbering-and-counters.md](gapless-numbering-and-counters.md) — another case of `ON CONFLICT` doing double duty, there as a lazy row-seeding idiom rather than a dedupe guarantee
