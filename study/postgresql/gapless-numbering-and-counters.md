# Gapless(-ish) Numbering with a Counter Row

> A `SEQUENCE` is fast and safe under concurrency, and it is also, by design, allowed to leave gaps — which makes it the wrong tool the moment a human-facing document number matters.

**Category:** PostgreSQL
**Introduced by:** Phase 3.8 — `ledger_invoice_settings.next_number`, allocating `INV-000001`, `INV-000002`, … as invoices are issued
**Verified against:** PostgreSQL 16

---

## Mechanism

### Why `SEQUENCE` and `MAX(n)+1` both fail here

PostgreSQL's `SEQUENCE` object (what `SERIAL`/`GENERATED ... AS IDENTITY` use underneath) is built to never block a writer. Two transactions can call `nextval()` concurrently and each gets a distinct value immediately, without waiting on each other — but that speed comes from the values being handed out **outside of MVCC**, meaning a `nextval()` call is not rolled back if its transaction later aborts. Call it once and roll back, and that number is gone forever; nothing hands it out again. For a surrogate primary key that is a non-issue. For an invoice number an auditor expects to see continuously — `INV-000001` through `INV-000047` with no explanation for a missing `INV-000023` — a sequence is the wrong primitive.

`SELECT MAX(n) + 1 FROM invoices` looks gapless but is a race: two concurrent transactions can both read the same `MAX(n)`, both compute `n + 1`, and both try to insert it — one succeeds, one hits a unique-constraint violation (or worse, if there's no unique constraint, both succeed and the number is duplicated). It also requires a full index scan of the largest values on every issue, and it does not compose per-tenant without extra scoping.

### The counter-row-with-lock pattern

The fix is a dedicated row holding the *next* number, incremented with a single `UPDATE ... RETURNING`:

```sql
UPDATE ledger_invoice_settings
   SET next_number = next_number + 1
 WHERE org_id = $1
 RETURNING next_number - 1 AS allocated, number_prefix, number_padding
```

The mechanism that makes this safe under concurrency is PostgreSQL's row-level locking, not application logic. `UPDATE` takes an exclusive lock on the specific row it modifies as soon as it identifies that row — before evaluating the `SET` expression on it — and holds that lock until the transaction commits or rolls back. A second concurrent `UPDATE` targeting the *same* `org_id` row blocks at the `UPDATE` statement itself, waiting for the first transaction to finish. It cannot read a stale `next_number` and compute a colliding value, because it cannot even start evaluating until the lock is free. This is the same mechanism `SELECT ... FOR UPDATE` uses explicitly (see `study/postgresql/transactions-isolation-pooling.md`); a plain `UPDATE` acquires the equivalent row lock implicitly as part of finding the row to modify.

Because the lock is scoped to one row — `org_id`'s counter row — two different organizations issuing invoices at the same instant do not contend with each other at all. Only two invoices from the *same* organization racing to issue serialize, which is the smallest possible blast radius for the lock.

### Why the allocation happens inside the invoice's own transaction

`allocateInvoiceNumber` takes the caller's already-open transaction client, never `pool` — it runs as one more statement inside `issueInvoice`'s single `BEGIN … COMMIT`, alongside the journal-entry posting and the status flip. That placement is what makes "gaps are possible, but only on a genuine rollback" true rather than "gaps happen randomly": if `issueInvoice` fails for any reason after allocating the number — the balance check trips, the account lookup fails, the deferred trigger rejects the entry — the whole transaction rolls back, and the `UPDATE next_number = next_number + 1` rolls back with it. The counter reverts to its pre-attempt value, and the *next* successful issue reuses the number nobody actually got. A gap only survives if the transaction reaches `COMMIT` and something external (a crash between COMMIT calls, which cannot happen mid-statement in Postgres) destroys evidence of the invoice — which does not happen here, since the `UPDATE` and the invoice row's status flip commit atomically together.

If the number were instead allocated in its own separate transaction before `issueInvoice` began, a later failure inside `issueInvoice` would leave that allocation committed and burned — a real, permanent gap on every failed issue attempt, not just a theoretical one.

### `ON CONFLICT DO NOTHING` as a lazy row seed

`ledger_invoice_settings`, like `ledger_settings` before it, has no seed row and no backfill — its absence means "never configured," and `getInvoiceSettings` returns defaults for a missing row rather than a `404`. But `allocateInvoiceNumber` needs a *real* row to lock and increment. Rather than requiring every organization to have configured invoice settings before issuing its first invoice, the allocator creates the row lazily:

```sql
INSERT INTO ledger_invoice_settings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING;
```

`ON CONFLICT (org_id) DO NOTHING` is idempotent and safe under the same concurrency this whole mechanism defends against: if two transactions both race to insert the first row for an organization, one succeeds and the other's insert becomes a no-op rather than an error, and both proceed to the `UPDATE` that follows — which then serializes on the row exactly as before. This is the same idiom `study/postgresql/transactions-isolation-pooling.md` documents as the concurrency-safe alternative to "check if it exists, then insert."

### What "gapless" actually means in practice

Despite the name of this pattern, it is not perfectly gapless — a transaction that allocates a number and then the *client* disconnects before ever calling `/issue` again would still burn nothing, because the allocation is inside the transaction; but an organization that issues, then immediately voids, an invoice keeps that invoice's number permanently (voiding does not return the number to the pool — the invoice still exists, just marked `VOID`). What this pattern actually guarantees is stronger than "gapless" and more useful: every number that is ever handed out corresponds to a row that really was created inside a transaction that committed. Auditors call this **sequential and accounted for**, not strictly gapless, and it is what real accounting systems (including QuickBooks, Xero) actually provide — a true gapless guarantee across arbitrary failures needs a separate reservation/confirmation protocol that is not worth the complexity here.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| PostgreSQL `SEQUENCE` | Never blocks, cheapest under concurrency | Rejected — burns a number on every rolled-back transaction, by design; unacceptable for an audited document number |
| `SELECT MAX(n) + 1` | No dedicated counter state to maintain | Rejected — read-then-write race under concurrency; either a unique-constraint failure or, without one, a silent duplicate |
| A counter row + `UPDATE ... RETURNING` inside the document's own transaction | One extra row, one extra statement per issue | **Chosen** — serializes only same-org concurrent issuers, and a rollback of the whole operation naturally reverts the allocation |
| A separate reservation table (allocate now, confirm later) | True gaplessness across any failure, including a crash between allocate and use | Rejected as overkill — the counter-in-transaction approach already ties allocation to a real committed row; the extra protocol buys a guarantee this system doesn't need |

## Where it lives in this codebase

- `server/src/db/migrations/007_ledger-core_invoice_settings.sql` — `next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0)`
- `server/src/services/ledger-core/invoiceSettingsService.ts` — `allocateInvoiceNumber(client, orgId)`, taking a `Queryable` restricted to the caller's transaction client, never `pool`
- `server/src/services/ledger-core/invoiceService.ts` — `issueInvoice` calls it inside its own `BEGIN…COMMIT`, before posting the journal entry
- `server/src/__tests__/ledger-core/invoices.test.ts` — `'allocates the next number on a second invoice'` asserts `INV-000001` then `INV-000002` in sequence

## Gotchas

- `allocateInvoiceNumber` **must never** be called with `pool` instead of a transaction `client` — doing so would commit the increment immediately, on a different connection than the invoice write, and a subsequent failure in `issueInvoice` would burn the number for real (guardrails rule 5).
- The row lock only protects against concurrent *writers*. A read of `next_number` outside a lock (e.g. for display, "next invoice will be numbered...") can be stale by the time an actual issue happens — which is fine for a preview, but must never be trusted as the number that will actually be used.
- Voiding an invoice does not reclaim its number. If the business ever wants number reuse after a void, that's a deliberate, separate decision — not a bug in this mechanism.
- The `UPDATE` locks the *counter row*, not the invoices table — a long-running unrelated transaction holding a lock on the same organization's `ledger_invoice_settings` row (say, someone mid-edit on invoice defaults, in a transaction that hasn't committed) would block an issue attempt until it releases. In practice, `updateInvoiceSettings` runs and commits in a single statement, so this window is negligible.

## Interview Q&A

**Q: Why can't you just use a `SERIAL` column or a `SEQUENCE` for a human-facing invoice number?**
A: A `SEQUENCE` hands out values outside of MVCC specifically so it never blocks concurrent callers — but that means a value it hands out to a transaction that later rolls back is gone forever, by design. For a surrogate key that's invisible and irrelevant. For an invoice number, a permanent, unexplained gap looks like a missing or hidden invoice to an auditor, so the speed trade-off that makes sequences good for primary keys makes them wrong here.

**Q: How does `UPDATE ... SET next_number = next_number + 1 ... RETURNING` stay safe if two requests try to issue an invoice for the same organization at the same instant?**
A: `UPDATE` takes a row-level lock on the row it's about to modify before it evaluates the `SET` expression, and holds it until the transaction ends. The second concurrent `UPDATE` targeting that same counter row blocks at the statement level — it can't even start computing `next_number + 1` until the first transaction commits or rolls back — so there's no window where both read the same value and both write the same increment. It's the implicit version of `SELECT ... FOR UPDATE`.

**Q: Why is the number allocated inside the invoice's own transaction rather than in a separate step before it?**
A: So that a failure anywhere else in the issue operation — the balance check, the account lookup, the deferred constraint trigger — rolls back the number allocation along with everything else. If the allocation had already committed in its own transaction, that number would be permanently burned on every failed issue attempt. Tying it to the same transaction means a gap only survives a real commit, not a failed attempt.

**Q: Is this truly gapless?**
A: Not in the strictest sense — voiding an already-issued invoice doesn't return its number to the pool, so the sequence has "holes" corresponding to voided documents, which is actually the behavior auditors want (a voided invoice is accounted for, not erased). What this mechanism guarantees is that every number ever issued corresponds to a real committed row; the only way to get a permanent gap with no corresponding row is a scenario this system doesn't produce, since the allocation and the invoice write commit atomically together.

**Q: What would you do differently if numbering needed to be strictly gapless even across process crashes mid-transaction?**
A: PostgreSQL's transactional guarantees already cover a crash mid-transaction — either the whole `BEGIN…COMMIT` lands or none of it does, so a crash can't leave a "half-issued" invoice with a burned number. The scenario that would need more machinery is a two-phase workflow where the number has to be reserved before some external, non-transactional side effect (an email send, a call to an external e-invoicing API) that can't be rolled back — that needs a reservation/confirmation table so a failed external step can release the reservation rather than leaving a mystery gap.

## Follow-ups they'll dig into

- What if the organization's counter row doesn't exist yet when the first invoice is issued? (Handled by `INSERT ... ON CONFLICT (org_id) DO NOTHING` immediately before the `UPDATE`, itself safe under the same concurrency this pattern defends against.)
- How would you support resetting the counter per fiscal year (e.g. `INV-2026-000001` resetting to `1` each January)? (Would need the reset logic to run inside the same locked-row transaction as the allocation, checking the current year against a stored "last reset year" column before deciding whether to increment or reset — still one row, one lock, just a slightly richer update.)

## See also

- [transactions-isolation-pooling.md](transactions-isolation-pooling.md) — row locks, `FOR UPDATE`, and why `pool.query` escapes a transaction
- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the other place this codebase relies on a failed `COMMIT` rolling back everything, including side effects computed earlier in the same transaction
- [../architecture/document-lifecycle-fsm.md](../architecture/document-lifecycle-fsm.md) — the invoice number is allocated at exactly the `DRAFT -> ISSUED` transition, never before
