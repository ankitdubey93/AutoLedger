# Background Jobs & Queues (BullMQ on Redis)

> A queue is two data structures on one Redis instance — a list for "waiting" and a sorted set for "delayed" — plus a Lua script that moves a job between them atomically, so "exactly one worker claims this job" needs no distributed lock.

**Category:** Architecture · Node/Express
**Introduced by:** Phase 7 — `server/src/queue/`, the outbox drain, the scheduled integrity check; extended Phase 10 — `ap-flow-extract`, the first purely event-driven, non-repeatable queue
**Verified against:** `bullmq` ^6.3.4, `ioredis` ^6.0.0, Redis 7, Node 22

---

## Mechanism

### What a queue actually is on Redis

BullMQ models a queue as a small set of Redis keys sharing a prefix (`bull:<queue-name>:*`):

- `wait` — a **list**. `LPUSH` to add, `BRPOPLPUSH` to atomically pop-and-move to `active` in one round trip. The blocking pop is why a worker can sit idle at zero CPU instead of polling.
- `active` — a list of jobs currently being processed. A job here has a **lock**, renewed periodically by the worker; if the worker dies, the lock expires and a maintenance sweep moves the job back to `wait` (or `failed`, once retries are spent).
- `delayed` — a **sorted set**, scored by the timestamp the job should become runnable. A repeatable job (`upsertJobScheduler`) is implemented as a delayed job that re-schedules itself after each run.
- `completed` / `failed` — sorted sets of finished jobs, capped by `removeOnComplete`/`removeOnFail` so they don't grow forever.
- A per-job hash (`bull:<queue>:<id>`) holding the payload, options, and result/error.

Every state transition (`wait → active`, `active → completed`, `active → failed → retry (delayed) → wait`) is a **Lua script** executed atomically on the Redis server. That's what makes two workers popping from the same `wait` list race-free without either process taking an explicit lock: Redis itself is single-threaded for command execution, so the script's `RPOPLPUSH`-plus-bookkeeping is indivisible.

### Why `maxRetriesPerRequest: null` is mandatory

`ioredis`'s default retry budget (20 attempts) is designed for request/response commands — `GET`, `SET` — where a command that never returns is a bug. `BRPOPLPUSH` is different: it is *meant* to block for a long time waiting for work, and ioredis's retry counter doesn't distinguish "this connection is broken" from "this command is legitimately still waiting." Left at the default, a worker sitting on an empty queue eventually throws `MaxRetriesPerRequestError` and dies. Setting it to `null` tells ioredis "commands on this connection can wait forever; only a real connection failure is an error" — which is BullMQ's own documented requirement for any connection it manages.

### Retry, backoff, and the dead-letter queue

`defaultJobOptions: { attempts: N, backoff: { type: 'exponential', delay: D } }` means: on failure, re-run up to `N` times total, waiting `D, 2D, 4D, …` between attempts. BullMQ tracks `job.attemptsMade`; the `'failed'` event fires after *every* failed attempt, not just the last one — so "has this job exhausted its retries" is a check the consumer must make itself (`job.attemptsMade >= (job.opts.attempts ?? default)`), not something BullMQ tells you directly.

`removeOnFail: false` keeps a permanently-failed job's hash in Redis indefinitely — the record survives so it can be inspected. That alone doesn't give you *alerting*, though: nothing pages an operator just because a hash sits in the `failed` sorted set. The **dead-letter queue** (`'dead-letter'` here) is the alerting mechanism: on terminal failure, the worker's `'failed'` listener explicitly enqueues a summary (`{ queue, jobId, failedReason, payload }`) onto a queue *nothing consumes*, so it accumulates as a visible backlog an operator (or a future watcher) checks, rather than requiring someone to know to look inside the original queue's `failed` set.

### Repeatable jobs: `upsertJobScheduler`, not `add({ repeat })`

Older BullMQ versions scheduled repeatable jobs via `queue.add(name, data, { repeat: { pattern } })`; calling that on every process start could silently accumulate duplicate schedulers. `upsertJobScheduler(schedulerId, repeatOpts, jobTemplate)` is idempotent by design — it creates or *updates* the scheduler identified by `schedulerId`, so restarting the worker process never produces two competing timers for the same job. `{ pattern: '0 3 * * *' }` is a cron string; `{ every: 5000 }` is a fixed interval — both go through the same call.

### Why the worker is a separate OS process, not a thread

Node's event loop is single-threaded for JavaScript execution. A CPU-bound handler (parsing a large CSV, computing an integrity report over the whole `ledger_lines` table) run in-process with the Express server would block every in-flight HTTP request for its duration — the exact failure mode [event-loop-and-blocking.md](../node-express/event-loop-and-blocking.md) covers. `worker_threads` would fix the blocking but shares nothing safely except `SharedArrayBuffer`/message-passing, which is awkward for something that mostly does database I/O anyway (I/O doesn't block the loop; only synchronous CPU work does). A **second process** (`server/src/worker.ts`, started with `npm run worker`) sidesteps the question entirely: it has its own event loop, its own `pg` pool, its own crash domain — a worker OOM or an uncaught exception in a handler takes down job processing, never the API. The two processes coordinate through Redis and Postgres, not shared memory, which is also why every job payload here is *just an id* — the worker re-reads current data from Postgres rather than trusting a value that rode along in Redis.

### At-least-once delivery, and why idempotency is the price of it

BullMQ (like virtually every real-world queue) guarantees **at-least-once** execution, not exactly-once. A worker can crash after finishing the real work but before the job is marked `completed`; on restart, the stalled-job sweep reclaims it and it runs again. The honest fix is not "try harder to make it exactly-once" (impossible without a distributed transaction spanning Redis and whatever the job touches) — it's making every handler safe to run twice. This codebase does that at two levels: `enqueue(..., { jobId })` deduplicates *identical* re-adds (BullMQ silently drops a second `add` with a `jobId` already present), and `webhookDeliverHandler` separately checks `delivery.status !== 'PENDING'` before sending, so even a job that *does* run twice (different jobId, same underlying delivery) is a no-op the second time.

### An event-driven queue with no scheduler entry

Every queue before Phase 10 is either a repeatable job (`outbox-drain` every 5s, `integrity-check` daily, both via `upsertJobScheduler`) or a reaction to an event that's already durable elsewhere (`webhook-deliver`, enqueued by the outbox drain reading a Postgres row). `ap-flow-extract` (Phase 10) is the first queue that is purely **event-driven and one-shot**: it gets exactly one `enqueue()` call per user action (registering a document, or requesting a re-extraction), no `upsertJobScheduler` entry at all, and the `HANDLERS` map's own type (`Record<Exclude<QueueName, 'dead-letter'>, ...>`) makes forgetting to wire up its handler a compile error rather than a silent gap.

The `jobId` on each call is doing real dedup work, in two different directions:

```ts
// registration — one job per document, ever, unless it's re-extracted
await enqueue('ap-flow-extract', { orgId, apFlowDocumentId: id }, {
  jobId: `ap-flow-extract-${id}`,
});

// re-extraction — a NEW jobId so it isn't silently dropped as a duplicate
await enqueue('ap-flow-extract', { orgId, apFlowDocumentId: id }, {
  jobId: `ap-flow-extract-${id}-${Date.now()}`,
});
```

The first call's `jobId` is deterministic from the document's own id — BullMQ silently drops a second `add()` sharing a `jobId` already present in the queue, so registering the same document twice (a double-click, a retried request) can never fan out two jobs for one document. The second call deliberately breaks that determinism by folding in a timestamp: a re-extraction is a *new* unit of work, not a duplicate of the first, and reusing the original `jobId` there would mean BullMQ drops it as "already seen," permanently blocking the very feature `POST /:id/reextract` exists to provide. Same primitive, two opposite outcomes, chosen deliberately per call site — this is also why `jobId`s use `-` rather than `:` as a delimiter: BullMQ reserves `:` as an internal key separator and rejects a custom id containing one.

### Why this enqueue sits outside its transaction, when the outbox exists for exactly that problem

`apFlowDocumentService.createApFlowDocument` calls `enqueue()` *after* its `withTransaction` block returns — deliberately outside the transaction, not inside it. That looks, at first glance, like exactly the dual-write problem the transactional outbox ([transactional-outbox.md](transactional-outbox.md)) exists to solve: a Postgres commit and a Redis write are two separate systems, and nothing atomically ties them together. A crash in the gap between them leaves the database saying one thing (`ap_flow_documents.status = 'PENDING'`) and Redis saying nothing happened.

The reason this isn't routed through the outbox is what's actually at stake on either side of that gap. The outbox exists because losing a *financial* event silently — a webhook nobody gets told about, a payment notification that vanishes — is unacceptable, and the cost of the mechanism (a durable event row, a drain process, `FOR UPDATE SKIP LOCKED` claiming) is worth paying for that guarantee. Here, the entire phase posts nothing to the ledger — the worst case of the gap is a document visibly stuck at `PENDING` with no job ever queued for it, which is both visible (the status says so) and repairable by the user themselves (`POST /:id/reextract`, which enqueues fresh). Reaching for the outbox pattern everywhere a Postgres write and a Redis write are adjacent — rather than only where losing the second write silently is genuinely costly — would be solving a problem this phase doesn't have at the price of a mechanism it doesn't need.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| BullMQ + Redis | An extra service to run; Redis was already provisioned since Phase 0 for exactly this | **Chosen** — mature retry/backoff/scheduler primitives, and the infrastructure was already reserved |
| `pg-boss` (Postgres-backed queue) | No new service — jobs live in the same database as everything else | Rejected for Phase 7: it would put job-queue contention (frequent polling `UPDATE`s) on the same database serving live financial reads, and Redis was already the planned answer. A DB-backed queue is a defensible choice in a system *without* Redis already in play |
| `agenda` (MongoDB-backed) | Similar shape to `pg-boss` | Rejected — introduces a third datastore for no offsetting benefit |
| A hand-rolled `SELECT ... FOR UPDATE SKIP LOCKED` poller | Zero new dependencies | This is *literally* what the outbox drain already does, at a smaller scale — see [transactional-outbox.md](transactional-outbox.md). Building an entire retry/backoff/scheduler system by hand on top of it was judged not worth it once a stable library is one dependency away |
| `worker_threads` in the API process | No second deployable | Rejected — see Mechanism above: a worker crash would share a crash domain with the API, and most of the work here is I/O-bound anyway, which threads don't help with |

## Where it lives in this codebase

- `server/src/queue/connection.ts` — the shared `ioredis` connection factory (`maxRetriesPerRequest: null`) and the health-check ping
- `server/src/queue/queues.ts` — one typed `Queue` per name in `QUEUE_NAMES`, the `enqueue()` wrapper, retry/backoff defaults
- `server/src/queue/worker.ts` — `startWorkers()`/`stopWorkers()`, the dead-letter `'failed'` listener, the two `upsertJobScheduler` calls
- `server/src/worker.ts` — the process entry point (`npm run worker`), mirroring `index.ts`'s shutdown discipline
- `server/src/queue/handlers/` — `integrityCheckHandler.ts` (Phase 5's on-demand check, now scheduled daily), `outboxDrainHandler.ts`, `webhookDeliverHandler.ts`, `apFlowExtractHandler.ts` (Phase 10, event-driven, no scheduler entry)
- `server/src/services/ap-flow/apFlowDocumentService.ts` — the two `enqueue()` call sites, one deterministic `jobId` (registration), one timestamp-suffixed (re-extraction)

## Gotchas

- **Forgetting `maxRetriesPerRequest: null`.** A worker on an idle queue throws `MaxRetriesPerRequestError` and dies — looks like a Redis outage, isn't one.
- **`'failed'` fires on every attempt, not just the last.** Checking `job.attemptsMade >= configuredAttempts` is required before treating a failure as terminal.
- **`queue.add({ repeat })` on every process start.** Without `upsertJobScheduler`'s idempotency, each restart can add a competing scheduler.
- **Trusting the job payload as data.** A payload is a hint about *what* to process, not a cache of *what it contained* — always re-read from Postgres, both for correctness (data may have changed) and for the tenant-safety property described in `webhookDeliveryService`'s worker-side reads.
- **Forgetting to close `Queue`/`Worker` instances in tests.** Vitest hangs for ~10s reporting a vague "something prevents Vite server from exiting" — the real cause is an open Redis connection.

## Interview Q&A

**Q: How does BullMQ guarantee only one worker processes a given job, without an explicit lock?**
A: The move from the `wait` list to the `active` list happens inside a single Lua script executed by Redis. Redis processes one command (or script) at a time — it's effectively single-threaded for execution — so the script's `BRPOPLPUSH`-plus-bookkeeping is atomic from every client's point of view. Two workers calling it concurrently can't both pop the same list entry; one gets the job, the other blocks for the next one. No distributed lock is needed because the primitive that would normally require one is itself atomic.

**Q: What does `attempts: 5` with exponential backoff actually do, mechanically?**
A: On a thrown error, BullMQ doesn't discard the job — it re-queues it as a *delayed* job, scored in the `delayed` sorted set at `now + backoff_delay`. `job.attemptsMade` increments each time. Once `attemptsMade` reaches the configured `attempts`, the next failure is terminal: BullMQ marks the job `failed` and stops retrying. The delay grows exponentially (1s, 2s, 4s, 8s for a 1s base) so a flaky dependency gets breathing room proportional to how long it's been down.

**Q: Why is `removeOnFail: false` not sufficient as an alerting mechanism on its own?**
A: It preserves the *record* — the job's hash stays in Redis's `failed` sorted set instead of being deleted — but nothing *notifies* anyone. An operator would have to know to inspect that specific queue's failed set. The dead-letter queue makes failure visible without that prior knowledge: a terminal failure is actively pushed onto a queue whose only purpose is to accumulate things that need a human, so "is anything broken" is answerable by checking one place.

**Q: Why run the worker as a separate process instead of `worker_threads` inside the API server?**
A: Fault isolation and simplicity, mostly. A crash inside a job handler — an uncaught exception, an OOM from a large CSV — would, in a shared process, take the API down with it; as a separate process it only stops job processing, and the API keeps serving. `worker_threads` avoids that specific crash-domain problem but shares almost nothing safely except explicit message-passing, which buys little here since the actual work is database I/O, not CPU-bound computation the event loop needs protecting from. A second process talking to the same Postgres and Redis is a simpler mental model for what is, in practice, I/O-bound work.

**Q: What happens if a worker process is killed mid-job (`SIGKILL`, out of memory)?**
A: The job stays in the `active` list holding a lock the (now-dead) worker can no longer renew. BullMQ's maintenance routine periodically checks for jobs whose lock has expired and reclaims them — moving them back to `wait` to be retried by whichever worker picks them up next (possibly the same one, after restart). This is exactly why handlers must be idempotent: the job *will* sometimes run more than once, and "crashed after doing the real work but before acknowledging completion" is indistinguishable, from the queue's point of view, from "crashed before doing anything."

**Q: Your outbox drain runs every 5 seconds via a repeatable job. Why not just use a plain `setInterval` in the worker process?**
A: A `setInterval` ties the schedule to one specific process's lifetime — if that process is mid-restart (a deploy, a crash-restart) the tick is simply missed with no record of it, and running two worker instances for redundancy would double-fire it. `upsertJobScheduler` puts the schedule *in Redis*, shared state every worker instance reads: exactly one worker claims each tick (same `wait`-list mechanism as any other job), a missed tick because every worker was briefly down still gets caught up (it becomes a delayed job for "as soon as possible" rather than silently vanishing), and adding a second worker process for throughput doesn't double the frequency.

**Q: AP-Flow's document-registration enqueue happens outside its own database transaction, right after it commits. Isn't that exactly the dual-write problem the transactional outbox exists to fix?**
A: Structurally, yes — a Postgres commit and a Redis write are two separate systems with no atomic tie between them, and a crash in the gap leaves the database saying "PENDING" with no job ever queued for it. The reason it isn't routed through the outbox is what's actually lost if that gap is hit: the outbox protects *financial* events, where losing one silently is unacceptable and worth the mechanism's real cost (a durable event row, a drain process, row-locking to claim work). Here, nothing has posted to the ledger — the failure mode is a document visibly stuck at `PENDING`, which the user can see and fix themselves by re-requesting extraction. Paying the outbox's cost everywhere a Postgres write sits next to a Redis write, rather than only where the loss is genuinely expensive, would be solving a problem this feature doesn't have.

**Q: You use two different `jobId` strategies for the same queue — a deterministic id for registration, a timestamp-suffixed one for re-extraction. Why not just always use a fresh id?**
A: Because the deterministic id on registration is doing real work: BullMQ silently drops a second `add()` sharing a `jobId` already present in the queue, so a duplicate registration request (a double-click, a client retry after a slow response) can never fan out two extraction jobs for the same document — that's a feature, not friction. Re-extraction is different in kind, not degree: it's a *new*, deliberate unit of work the user explicitly asked for, and reusing the original deterministic id there would mean BullMQ treats it as the same job already seen and drops it — permanently breaking the re-extract feature the moment someone tried to use it twice. Same dedup primitive, applied deliberately in opposite directions depending on whether "this is the same request" or "this is a new request" is actually true.

## Follow-ups they'll dig into

- "How would you scale this to multiple worker processes?" (Already safe — the `active`-list claim is atomic across any number of workers pointed at the same Redis; `concurrency` per worker and worker *count* are independent scaling knobs.)
- "What happens if Redis itself goes down?" (New enqueues fail — but see `outboxDrainHandler`'s stale-sweep design in [transactional-outbox.md](transactional-outbox.md): the durable record is a Postgres row, not the Redis job, so a Redis outage delays delivery rather than losing events.)
- "How do you test retry/backoff without waiting for real delays?" (`JOB_BACKOFF_MS` and `JOB_ATTEMPTS` are both `env.isTest`-gated to tiny values, matching the existing `BCRYPT_COST` pattern for test-speed constants.)
- "Why not just poll the database every N seconds instead of using a queue at all?" (That's what the outbox drain *is*, one layer down — BullMQ adds the retry/backoff/visibility machinery on top so you don't hand-roll it for every job type.)

## See also

- [transactional-outbox.md](transactional-outbox.md)
- [../node-express/event-loop-and-blocking.md](../node-express/event-loop-and-blocking.md)
- [../node-express/graceful-shutdown-and-process-lifecycle.md](../node-express/graceful-shutdown-and-process-lifecycle.md)
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — `FOR UPDATE SKIP LOCKED`, the same primitive at smaller scale
- `docs/guardrails.md` rule 5, rule 14
