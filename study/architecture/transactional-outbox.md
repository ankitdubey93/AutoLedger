# The Transactional Outbox Pattern

> You cannot atomically commit a Postgres transaction and send an HTTP request — so instead you atomically commit the *fact that a request needs sending*, and let a separate process do the sending, as many times as it takes.

**Category:** Architecture
**Introduced by:** Phase 7 — `outbox_events`, `outboxService.emitEvent`, the outbox drain handler
**Verified against:** PostgreSQL 16, BullMQ ^6.3.4

---

## Mechanism

### The dual-write problem, stated precisely

Issuing an invoice does two things that both need to "happen": the invoice is posted to the ledger (a Postgres write), and — if this feature exists — a downstream system is told about it (an HTTP call to a webhook receiver). These are two different systems with no shared transaction manager between them. Every ordering of "write to Postgres" and "call the webhook" has a failure mode:

- **Call the webhook, then write to Postgres.** If the write fails (a constraint violation, a crashed process), the receiver was told about an invoice that doesn't exist.
- **Write to Postgres, commit, then call the webhook.** If the process crashes between `COMMIT` and the HTTP call — which can happen for any reason, at any instant, including a mundane deploy — the invoice exists but the event is lost forever. There is no "resume from here" because nothing durable recorded that the call was ever supposed to happen.
- **Call the webhook inside the Postgres transaction, before `COMMIT`.** Now the transaction holds its connection (and any locks it has taken) open for the duration of a network round trip to a third party, and if the webhook call fails, does the whole invoice posting roll back over an unrelated system being down? Neither answer is good.

This is why guardrails rule 5 states it as a flat rule: **no post-`COMMIT` follow-up work in the same function.** The rule sounds like caution; the outbox is the mechanism that actually satisfies it.

### The fix: make the intent durable in the same transaction as the fact

```sql
-- Inside the SAME transaction, on the SAME client, as the invoice's own writes:
INSERT INTO outbox_events (org_id, app_slug, event_type, payload)
VALUES ($1, 'ledger-core', 'invoice.issued', $2::jsonb);
```

`outboxService.emitEvent(client, ...)` takes the caller's `PoolClient` — never `pool` — for exactly the reason [transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) explains: a `pool.query` here would run on a *different* session and commit immediately regardless of what happens to the invoice. Because the event row is written with the same `client`, it is bound to the same atomicity as everything else in that transaction. If the invoice posting rolls back (a locked fiscal period, a balance check failure), the event row rolls back with it — there is no code path where the fact and the intent-to-notify disagree.

Once committed, the row is durable, decoupled from Redis, from the network, from the webhook receiver being up. Delivery becomes a separate concern, handled by something that can retry indefinitely without threatening the correctness of the invoice itself.

### Draining: `FOR UPDATE SKIP LOCKED` as a work-claiming primitive

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

`FOR UPDATE` alone takes an exclusive row lock and makes a second transaction *wait* for it — correct for "these two operations must not interleave," wrong for "hand out disjoint batches of work to N workers." `SKIP LOCKED` changes the semantics: a row already locked by another transaction is silently excluded from the result set instead of blocking on it. Two concurrent drain passes (two worker processes, or an overlapping retry) each get a **different** slice of the unpublished backlog — no blocking, no double-processing, no coordination needed beyond what Postgres's row locking already provides. This is the same primitive `NOWAIT` sits next to on the strictness spectrum: `FOR UPDATE` (wait), `NOWAIT` (error immediately), `SKIP LOCKED` (silently move on) — three different answers to "what do I do about a row someone else is using."

The partial index, `CREATE INDEX ... ON outbox_events (id) WHERE published_at IS NULL`, exists because the only rows the drain query ever looks at are the unpublished tail — a full index on `id` would grow forever tracking rows the query never touches again after they're published.

### Fan-out and its own idempotency

One event can have zero, one, or many subscribed endpoints. The drain inserts one `webhook_deliveries` row per (event, endpoint) pair:

```sql
INSERT INTO webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload)
VALUES (...)
ON CONFLICT (event_id, endpoint_id) DO NOTHING
RETURNING id
```

`UNIQUE (event_id, endpoint_id)` plus `ON CONFLICT DO NOTHING` makes the fan-out itself idempotent: re-running the drain against an event that was already fanned out (a retried transaction, an overlapping pass that somehow saw the same event) inserts nothing new, because the second `INSERT` for the same pair conflicts and is silently dropped. The insert's `RETURNING` naturally yields only the *newly created* rows, which is exactly the set that needs a fresh `webhook-deliver` job.

### The stale-PENDING sweep: what "at-least-once" costs

Committing the transaction and enqueuing to Redis are two separate operations — there is a window between them where the process could crash, taking the enqueue with it, while the `PENDING` `webhook_deliveries` row survives (it was already committed). Without a remedy, that row would sit `PENDING` forever with no job ever coming to send it.

The fix is a second query in the same drain pass:

```sql
SELECT id FROM webhook_deliveries
 WHERE status = 'PENDING'
   AND updated_at < now() - (:threshold_ms * INTERVAL '1 millisecond')
 ORDER BY updated_at
 FOR UPDATE SKIP LOCKED
 LIMIT $1
```

Any `PENDING` row untouched for longer than `DELIVERY_REENQUEUE_AFTER_MS` (60s) is treated as "its enqueue was probably lost" and re-enqueued. `enqueue(..., { jobId: 'delivery-<id>' })`'s deterministic job id makes this safe even when the original enqueue actually *did* succeed and the job just hasn't run yet: BullMQ drops the duplicate `add` silently, so the sweep can run every 5 seconds against every stale-looking row without ever producing two live jobs for the same delivery.

This is the honest shape of **at-least-once** delivery: the durable record (the `PENDING` row) is the source of truth, and everything downstream — the Redis job, the actual HTTP send — is disposable and can be regenerated from it. Exactly-once delivery across a network boundary is not achievable without a distributed transaction the receiver also participates in, which is why the receiver is expected to dedupe on `deliveryId` rather than the sender promising something it structurally cannot guarantee.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Enqueue to Redis right after `COMMIT`, no outbox table | One fewer table, simpler code path | Rejected — this is precisely the "crash between commit and send" gap guardrails rule 5 forbids. A lost event here means a downstream system silently never learns an invoice was issued |
| `LISTEN`/`NOTIFY` for the drain trigger | Push instead of poll — no 5-second latency | Rejected: `NOTIFY` is fire-and-forget. A payload sent while no session is listening (a restart, a brief outage) is simply gone — not durable, so it doesn't solve the actual problem, only the polling delay |
| CDC off the WAL (Debezium or similar) | No outbox table at all — every committed row change becomes an event automatically | Right idea at a different scale. It's a whole separate system (a WAL-reading connector, a Kafka-shaped pipeline) that is not justified for five event types on one application |
| Poll-and-drain with `FOR UPDATE SKIP LOCKED` | 5-second latency; one more table | **Chosen** — durable, horizontally safe across multiple drain workers, and needs nothing beyond Postgres and the queue infrastructure already being built for Phase 7 |

## Where it lives in this codebase

- `server/src/db/migrations/020_platform_outbox_and_webhooks.sql` — `outbox_events`, its partial index, and the deliberate choice not to audit it (high-volume, transient, no compliance value beyond the source row)
- `server/src/services/outboxService.ts` — `emitEvent` (on the caller's client), `claimUnpublishedEvents` (the one other documented `org_id`-unscoped query besides `db/integrity.ts`)
- `server/src/services/webhookDeliveryService.ts` — `createDeliveriesForEvent` (the idempotent fan-out), `claimStaleDeliveries` (the sweep)
- `server/src/queue/handlers/outboxDrainHandler.ts` — both passes, one transaction each, the enqueue loop outside any transaction
- `server/src/services/ledger-core/invoiceService.ts`, `billService.ts`, `paymentService.ts`, `fiscalPeriodService.ts`, `bankImportService.ts` — the five `emitEvent` call sites, each on the same `client` as the financial write it describes

## Gotchas

- **Calling `emitEvent` with `pool` instead of the transaction's `client`.** Defeats the entire pattern — the event commits regardless of what happens to the financial write it was supposed to describe.
- **Assuming the drain guarantees ordering.** It doesn't, beyond `ORDER BY id` within one pass — two events for the same org, drained in different passes under load, could theoretically fan out out of the order they were emitted. Not a problem for this system's five event types (none depend on strict ordering), but worth stating rather than assuming.
- **Treating a job existing in Redis as proof the event will be delivered.** The durable fact is the Postgres row; the job is disposable and regenerated by the sweep if lost.
- **Forgetting `ON CONFLICT DO NOTHING`.** Without it, a second drain pass over an event whose fan-out already happened would throw a unique-violation and abort that pass's transaction.
- **A receiver that doesn't dedupe on `deliveryId`.** At-least-once means a receiver *will* eventually see a duplicate (a retried job that actually succeeded the first time, a stale-sweep re-enqueue racing a slow-but-successful original attempt). This is the receiver's responsibility, and it's why `deliveryId` rides in the request body.

## Interview Q&A

**Q: What is the dual-write problem, and why can't you just "be careful" to avoid it?**
A: It's the situation where one logical operation needs to update two systems that don't share a transaction — here, Postgres and an HTTP receiver. No ordering of the two operations is safe: call-then-write risks notifying about something that never happened, write-then-call risks a crash in the gap losing the notification forever, and calling from inside the transaction blocks a database connection on a network round trip and conflates two unrelated failure domains. "Be careful" doesn't help because the failure is a process crash or network partition at an arbitrary instant — it's not a logic bug you can code around, it's a structural gap between two systems' failure models.

**Q: How does the transactional outbox solve it?**
A: It turns a two-system write into a one-system write. Instead of trying to atomically do the Postgres write *and* the HTTP call, you atomically do the Postgres write *and* a Postgres write recording "an HTTP call needs to happen." Both are ordinary rows in the same transaction, so Postgres's own atomicity covers them — no cross-system coordination needed. Actually sending the HTTP call becomes a separate, retriable concern handled by a process that reads the outbox and can fail and retry as many times as it needs, because the fact that it's *supposed* to fire is now durable.

**Q: Why `FOR UPDATE SKIP LOCKED` instead of plain `FOR UPDATE` for the drain query?**
A: `FOR UPDATE` would make a second concurrent drain pass *block* until the first one's transaction ends — correct if you need serialized access to the same rows, wrong if you want two workers to split a backlog of independent work. `SKIP LOCKED` tells Postgres to silently exclude already-locked rows from the result instead of waiting, so two drain passes running at the same time each grab a different, non-overlapping batch. It's the standard Postgres primitive for "implement a work queue" without hand-rolling a distributed lock.

**Q: This gives you at-least-once delivery, not exactly-once. Why not aim higher?**
A: Exactly-once across a network boundary isn't achievable without both sides participating in a distributed transaction, which an arbitrary webhook receiver obviously isn't going to do. The honest engineering answer is to guarantee at-least-once — never silently lose an event — and push the small remaining duplicate-handling burden onto the receiver via an idempotency key, here `deliveryId`. That's a well-understood, much cheaper contract than trying to build exactly-once semantics that don't actually exist end-to-end.

**Q: Walk me through what happens if the worker process is killed right after committing a delivery's PENDING row but before the Redis enqueue completes.**
A: The row is safely committed — Postgres already has it, durable. The enqueue never happened, so no job exists in Redis for it, and without a remedy it would sit PENDING forever. The stale-sweep half of the drain pass is exactly the remedy: every drain cycle (every 5 seconds) also looks for PENDING rows whose `updated_at` is older than a threshold and re-enqueues those. Because the job id is deterministic (`delivery-<id>`), even if the original enqueue actually *did* succeed and this is a false alarm, BullMQ just drops the duplicate `add` — so the sweep can run unconditionally without risking a double-send.

**Q: Why is `outbox_events` excluded from the audit trail, when webhook_endpoints is included?**
A: The audit trail's value is recording who changed a piece of configuration or a financial fact and when — `webhook_endpoints` is exactly that: a human decided to route financial data to a new URL, which is a compliance-relevant action. `outbox_events` and `webhook_deliveries` are high-volume derived machinery, not facts anyone configured — one row is created and updated automatically per event per subscriber, with no meaningful "who did this." Auditing them would multiply the audit table's size for rows that add no investigative value beyond what the *audited* source event (the invoice, the bill) already carries.

## Follow-ups they'll dig into

- "What if two drain passes somehow both claim the same event?" (They can't — `FOR UPDATE SKIP LOCKED` inside one `UPDATE` statement makes the claim atomic per row; a row is either locked by pass A or available to pass B, never both.)
- "How would you add ordering guarantees per endpoint?" (Not built here, but the shape would be a per-endpoint sequence number and the delivery handler checking it hasn't already advanced past this event before sending — turns "at-least-once" into "at-least-once, in order.")
- "What happens to in-flight deliveries if you delete a webhook endpoint?" (The composite FK's `ON DELETE CASCADE` removes the endpoint's `webhook_deliveries` rows with it; any Redis job for one becomes a no-op — `getDeliveryForSend` returns `null` and the handler logs and returns rather than throwing.)
- "How would this change if you needed to guarantee delivery within N seconds?" (The 5-second drain interval plus the queue's own processing time is your latency floor; tightening it is a config change, but a hard SLA usually means moving the enqueue closer to the write — e.g. a `LISTEN`/`NOTIFY` wake-up in addition to, not instead of, the durable poll as a backstop.)

## See also

- [background-jobs-and-queues.md](background-jobs-and-queues.md)
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — `FOR UPDATE SKIP LOCKED`'s general mechanics
- [../postgresql/idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — `ON CONFLICT DO NOTHING` as the same idempotency idiom applied to CSV import
- `docs/guardrails.md` rule 5
