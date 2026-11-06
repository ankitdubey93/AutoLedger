# Exactly-Once Reminders

> "Send one reminder per invoice per offset, even if two sweeps run at once" is a decision problem, not a delivery problem. Make the decision exactly once in the database; accept that the email itself is delivered at least once.

**Category:** Architecture · PostgreSQL
**Introduced by:** Phase 48 — payment reminders (`invoiceReminderService.ts`, `invoice_reminders`, `utils/invoiceReminders.ts`, the hourly `invoice-reminder-sweep` job)
**Verified against:** PostgreSQL 16.15 (the dev database the tests ran on), Node 22.23, BullMQ as pinned in `server/package.json`. Behaviour pinned by `invoiceReminders.test.ts` (including a `Promise.all` of two sweeps) and `invoiceReminders.unit.test.ts`. Not verified: behaviour under a real mail provider; Postgres documentation claims below are from memory of the 16 docs, not re-read this session.

---

## Mechanism

**The pure part.** `reminderOffsetDue(dueDate, today, offsets, alreadySent)` returns which offset (days after the due date, negative = before) to send now, or `null`. An offset has "passed" when `dueDate + offset <= today`, using `Date.UTC` arithmetic so a daylight-saving change or a leap day cannot shift it. It takes the **largest** passed offset and returns it only if it exceeds everything already sent. So an invoice discovered 45 days late gets one reminder at the 30-day offset, never three back-to-back (no back-fill). `today` is an argument; there is no `new Date()` inside, so every case is a table-driven unit test.

**The stateful part.** For each candidate invoice the service opens its own transaction and does, in order:

1. `SELECT pg_advisory_xact_lock(hashtextextended('<org>:<invoice>', 0))`. This is a lock on a *name*, held until the transaction ends. A second sweep working on the same invoice blocks here.
2. `SELECT 1 FROM invoice_reminders WHERE org_id, invoice_id, offset_days`. If a row exists, return without sending. Because the second sweep runs this statement only after it acquired the lock, and READ COMMITTED takes a fresh snapshot per statement, it sees the first sweep's committed row.
3. `sendInvoiceOnClient(client, ...)`: the send row, the outbox row and a history event, all on the same client.
4. `INSERT INTO invoice_reminders (... invoice_send_id)`.

Commit makes the reminder row, the send row and the outbox row appear together; a rollback removes all three.

**The final guard** is `UNIQUE (org_id, invoice_id, offset_days)`. The lock should make a conflict impossible between two sweeps, but the constraint holds even if some future code path forgets the lock. A `23505` is caught, the transaction (and the email with it) rolls back, and the invoice counts as neither sent nor failed.

## Why we chose it here

The plan first said "insert the reminder row `ON CONFLICT DO NOTHING RETURNING`, enqueue the email only if a row came back". That cannot work as written, because `invoice_reminders.invoice_send_id` is `NOT NULL` and the send does not exist until after the decision. Making the column nullable to reserve the slot first would weaken the integrity the table exists for. The advisory lock serialises check-then-send-then-insert instead, and the constraint remains the backstop. This is a deviation from the plan's wording, recorded in the plan file, not a silent substitution.

| Option | Trade-off | Verdict |
|---|---|---|
| `INSERT ... ON CONFLICT DO NOTHING RETURNING` first | Clean, but needs a nullable `invoice_send_id` or a placeholder | Rejected: weakens the schema |
| `SELECT ... FOR UPDATE` on the invoice | Works, but locks a money row that a payment in flight needs | Rejected: a reminder must never make a payment wait |
| `pg_advisory_xact_lock` on `org:invoice` | Locks a name, no row contention with payments; released automatically at commit/rollback | Chosen |
| SERIALIZABLE | Retries on serialization failure, heavier | Rejected: overkill for one key |
| Dedupe in Redis/BullMQ job id | Does not cover the case where the job is lost or the DB is the source of truth | Rejected: the decision belongs next to the data |

One transaction per invoice (not one per sweep) means one invoice's failure, logged with `{orgId, invoiceId}`, never aborts the rest, and a slow mail provider cannot hold a long transaction because the provider is not called inside it at all.

## Where it lives in this codebase

- `server/src/utils/invoiceReminders.ts` — the pure decision.
- `server/src/services/accounting/invoiceReminderService.ts` — candidate query, per-invoice transaction, `listOrgsWithReminders` (the one deliberately org-less query: it returns org ids only).
- `server/src/queue/handlers/invoiceReminderSweepHandler.ts`, `queue/worker.ts` — the hourly scheduler `invoice-reminder-sweep-tick`, `attempts: 1`.
- `server/src/db/migrations/105_ledger-core_invoice_delivery.sql` — `invoice_reminders` and its unique constraint.

## Gotchas

- **Eligibility has a guard against surprise.** A reminder needs at least one earlier non-failed send. Without it, switching reminders on would email every old or imported invoice in the organization.
- **A failed email must not count as "sent".** The "already sent" test and the sent/viewed display both ignore sends whose outbox row is `FAILED`.
- **"Exactly once" is about the decision.** After the commit, the outbox drain delivers at-least-once: a crash between the provider accepting the message and the row being marked `SENT` re-sends it. The customer can in principle receive a duplicate of one reminder; they can never receive two *different* reminder decisions for one offset. Say so plainly in an interview.
- **No per-customer opt-out** exists. A disputed invoice can only be voided, or reminders turned off for everyone.
- An advisory lock key is a hash: two unrelated names can collide on the 64-bit value, which only means occasional needless waiting, not wrong results.
- Dates are UTC (`todayIso()`), like every document except quotes; an organization far from UTC may see a reminder go out on a different calendar day than its own.

## Interview Q&A

**Q: Two workers run the same sweep at the same moment. How do you guarantee one reminder?**
A: The decision is serialised in Postgres. Each invoice is handled in its own transaction that first takes `pg_advisory_xact_lock` on a hash of org and invoice id, then checks the reminders table, sends, and inserts the reminder row. The second worker blocks on the lock, and when it proceeds its check sees the first worker's committed row and does nothing. A unique constraint on (org, invoice, offset) is the backstop if some other path ever skips the lock.

**Q: Why an advisory lock rather than `SELECT ... FOR UPDATE` on the invoice?**
A: A row lock on the invoice would also block a customer's card payment settling against that invoice, and a reminder is not worth making a payment wait. The advisory lock is on a name I invent, so it contends only with other reminder runs for that invoice. It is transaction-scoped, so commit or rollback releases it with no cleanup code.

**Q: Why do the send and the reminder row share one transaction?**
A: So they cannot disagree. If the reminder row committed without the email being enqueued, the invoice would never be reminded at that offset. If the email were enqueued without the row, the next sweep would send another. Writing the outbox row on the same client means both commit or both roll back; the unique-violation case even undoes the email.

**Q: Is it really "exactly once"?**
A: Exactly once for the *decision* to remind. Delivery after commit is at-least-once, because the worker can crash after the provider accepted the message but before the row was marked sent. True exactly-once across a network boundary needs the receiver to take part, which an email inbox cannot. I would not claim more than that.

**Q: An invoice is 45 days overdue and offsets are 7, 14, 30. What does the customer get?**
A: One reminder, at the 30-day offset, and nothing for 7 and 14. The function takes the largest offset that has passed and compares it with the largest already sent. Back-filling would send three emails in a row to someone who has just been added or just had reminders switched on.

**Q: Why is `today` a parameter instead of calling `new Date()`?**
A: A function that reads the clock cannot be tested for 'the day the offset passes' or a leap day without faking time. As an argument it is a plain table of inputs and outputs, and the integration tests pass dates explicitly too. Pure date arithmetic also uses `Date.UTC` so the host time zone cannot change the answer.

**Q: What would you change if you needed a different reminder cadence per customer?**
A: Move the offsets from organization settings onto the customer (or a rule table), and the unique key stays the same. The lock, the transaction and the pure function do not change, which is a sign the split was drawn in the right place. A per-customer opt-out is the smaller version of this and is not built.

## Follow-ups they'll dig into

- "What if the sweep crashes halfway through a batch?" (Each invoice committed or rolled back on its own; the next hourly run picks up the rest, and committed reminders are skipped by the check.)
- "What if the lock is never released?" (It is transaction-scoped, so a dropped connection ends the transaction and releases it.)
- "How would you make the email idempotent at the provider?" (Pass an idempotency key derived from the outbox row id, where the provider supports one. Brevo's behaviour here was not checked.)

## See also

- [transactional-outbox.md](transactional-outbox.md) — at-least-once delivery after commit, and the attachment-by-reference section
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — advisory locks and READ COMMITTED snapshots
- [../security-auth/user-authored-templates-and-bearer-links.md](../security-auth/user-authored-templates-and-bearer-links.md) — the reminder's link
- [background-jobs-and-queues.md](background-jobs-and-queues.md) — the scheduler pattern
