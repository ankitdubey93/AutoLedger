# Polymorphic references and insert-only history tables

> One `document_history` table serves thirteen kinds of entity through an `(entity_type, entity_id)` pair with no foreign key, so the service must prove ownership itself and the table must refuse to be edited.

**Category:** PostgreSQL · Architecture
**Introduced by:** Phase 46c — a Xero-style "History & notes" timeline under invoices, bills, notes, quotes, orders, payments, manual journals, contacts and bank lines
**Verified against:** PostgreSQL 16, Node 22, TypeScript strict. The org/user delete refusals were run against the dev database; the `TRUNCATE` and `clock_timestamp()` behaviour is from the PostgreSQL documentation, not separately tested; the Xero comparison is not verified.

---

## Mechanism

**The shape.** `document_history(id, org_id, entity_type, entity_id, kind, action, summary, details, actor_user_id, created_at)`. `entity_type` is a CHECK-constrained text; `entity_id` is a bare UUID. A timeline read is one index range scan: `(org_id, entity_type, entity_id, created_at DESC, id DESC)` serves `WHERE ... ORDER BY created_at DESC, id DESC LIMIT n` with no sort step.

**Why there is no foreign key.** A foreign key points at exactly one table. `entity_id` can name a row in thirteen tables (and two of them, quotes and orders, are split into sales/purchase entity types over one physical table). PostgreSQL has no "polymorphic FK". The consequence is that the database cannot stop a note being written against a nonexistent or another tenant's id. So `historyService.assertEntityExistsOnClient` runs, per entity type, a literal `SELECT 1 FROM <table> WHERE id = $1 AND org_id = $2` before any read or note. That check is also the tenant fence (guardrail rule 1): without it, org A could read org B's timeline by guessing a UUID. The rule 8 exception (a `*_id` column without `REFERENCES`) is documented in the migration header and in `docs/schema.md`, as `audit_logs.row_id` already is.

**Append-only by trigger.** `BEFORE UPDATE OR DELETE ... FOR EACH ROW` raising SQLSTATE `0A000` makes the table insert-only even for a buggy service or a manual `psql` session. One subtlety: **row-level triggers do not fire on `TRUNCATE`**. `TRUNCATE` needs its own statement-level trigger to be blocked. We deliberately leave it unblocked: the integration test helper `resetTables()` truncates every table between tests, and an operator with `TRUNCATE` privilege is outside the threat model this trigger addresses (a mistaken `UPDATE`/`DELETE`). The same trigger has two consequences I verified by running them in a rolled-back transaction: `DELETE FROM organizations` is refused once the organization has history (the cascade issues `DELETE FROM document_history`, which fires the row trigger), and `DELETE FROM users` is refused for a user who has written history, because `ON DELETE SET NULL` is an `UPDATE` of `actor_user_id` and the trigger rejects it. The application never deletes organizations or users, so nothing breaks today, but a future account-deletion feature must handle it (anonymise the user instead of deleting, or give the trigger a narrow exception for that single column). `audit_logs` avoids the problem by carrying no FK on `org_id` or `actor_user_id` at all (migration 017 explains why).

**`clock_timestamp()`, not `now()`.** `now()` (and `DEFAULT now()`) is the transaction start time, constant for the whole transaction. Issuing an invoice that also auto-applies a credit writes two events in one transaction; with `now()` they tie, and the timeline order falls to the `id` tiebreak, which is a random UUID. `clock_timestamp()` reads the wall clock at each call, so insertion order is preserved. The cost: the timestamp is no longer "the time the transaction began", which is irrelevant for a log.

**Writing in the business transaction.** Each service calls `recordEventOnClient(client, ...)` on the same checked-out client as the business write. Commit takes both, rollback takes neither (guardrail rule 5). Several events at once use one `INSERT ... SELECT ... FROM unnest(...)` rather than N round trips.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| One table, `(entity_type, entity_id)`, no FK | Simple, one query and one index for the UI; integrity enforced in the service | **Chosen** |
| One history table per entity (13 tables) | Real FKs, but 13 migrations, 13 services, 13 near-identical queries, and a new entity means a new table | Rejected |
| One table with an exclusive arc: 13 nullable FK columns plus `CHECK (num_nonnulls(...) = 1)` | Real FKs and cascades, but wide, mostly-NULL rows, a CHECK that grows with every entity, and 13 indexes | Rejected |
| Derive the timeline from `audit_logs` (CDC) | No extra writes, but rows are column diffs, not sentences; "Sent to a@b.com" or "Credit applied" is not recoverable from a diff; mixes raw trail with product feature | Rejected: `audit_logs` stays raw |
| Application-level event bus / outbox | At-least-once and async, so a committed change may lack its event | Rejected: the event must commit with the change |

## Where it lives in this codebase

- `server/src/db/migrations/101_platform_document_history.sql` — table, indexes, trigger, idempotent backfill
- `server/src/services/historyService.ts` — `recordEventOnClient`, `recordEventsOnClient`, `listHistory`, `addNote`, `assertEntityExistsOnClient`
- `server/src/routes/historyRoutes.ts` — one router factory mounted under 13 prefixes with each resource's own permission keys
- `client/src/components/history/HistoryAndNotes.tsx` — collapsed by default, fetches on expand

## Gotchas

- Forgetting the existence check on a new entity type leaks across tenants. The `switch` ends in a `never` exhaustiveness check so a new type fails to compile until it has a case.
- The `LIMIT` is a bound parameter (`LIMIT $4`), not an interpolated constant. A numeric module constant is not injectable, but the rule is "parameterized only" and it costs nothing to follow it.
- An actor of `NULL` means "system action" (a background sweep has no request context). `actor_user_id` is `ON DELETE SET NULL`, but that is itself an `UPDATE` and the append-only trigger refuses it, so a user with history cannot be deleted (verified; see Mechanism).
- A backfill must be idempotent because the migration replay test re-runs every file: `WHERE NOT EXISTS (...)`.
- Volume: one `IMPORTED` row per imported bank line (capped at 5000 per import).

## Interview Q&A

**Q: How do you model "a comment on any kind of record" in a relational database?**
A: Three options: a polymorphic pair `(type, id)` with no FK, a table per target, or an exclusive arc of nullable FKs with a CHECK that exactly one is set. The polymorphic pair is the cheapest and the most common, at the price of database-enforced integrity, so the application must validate that the target exists (and belongs to the tenant). I chose it because the access pattern is always "all rows for this one entity", never a join across entity types.

**Q: Why not just put a foreign key on `entity_id`?**
A: A foreign key references one table's key. This column can reference thirteen. PostgreSQL has no conditional or polymorphic FK, so the choices are to split the table, use an exclusive arc, or drop the constraint and enforce it in code. I dropped it, documented the exception, and put the existence-plus-org check in the only code path that touches the table.

**Q: Why `clock_timestamp()` instead of `now()` for a log's timestamp?**
A: `now()` is the transaction's start time and does not change within it, so two events written in one transaction have identical timestamps and ordering falls to a tiebreaker. `clock_timestamp()` returns the actual time at each call. It is non-deterministic and cannot be used in an index predicate, which does not matter here.

**Q: How do you make a table append-only, and what does that not cover?**
A: A `BEFORE UPDATE OR DELETE` row trigger that raises. It covers every client including `psql`. It does not cover `TRUNCATE` (needs a separate statement-level trigger), a superuser who disables triggers, or someone who drops the trigger. Real tamper-evidence needs hashing or external storage, which this is not.

**Q: Why write history in the same transaction instead of a queue?**
A: A queue is at-least-once and asynchronous, so a committed invoice could be missing its "Issued" event, or an event could exist for a transaction that rolled back. Writing on the transaction client gives atomicity for free. The cost is a few extra INSERTs inside the critical section, which are cheap and take no row locks on the business tables.

**Q: Why not derive history from your audit trigger?**
A: The CDC trail records column-level changes, not intent. "Credit note applied" is several row changes across tables; a human sentence cannot be reliably reconstructed from them. The two serve different audiences: audit is for forensics, history is a product feature. They are deliberately separate tables.

**Q: A user asks you to let people edit their notes. What changes?**
A: Not an UPDATE: the trigger forbids it. Add a new row of kind `NOTE` that supersedes the earlier one (a `supersedes_id` column) and have the read query hide superseded rows. That keeps the "nothing is rewritten" property, and the edit history is itself visible.

## Follow-ups they'll dig into

- What happens to history when an entity is deleted? (Documents here are never deleted once posted, bank lines are soft-deleted; with hard deletes you would have orphaned history, the cost of having no FK.)
- How would you paginate? (Keyset on `(created_at, id)`, which the index already supports; today it is capped at 500.)
- How would you shard this? (`org_id` leads the index, so it is a natural partition key.)

## See also

- [audit-triggers-and-session-variables.md](audit-triggers-and-session-variables.md)
- [../architecture/derived-system-account-roles.md](../architecture/derived-system-account-roles.md)
