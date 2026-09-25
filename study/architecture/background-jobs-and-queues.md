# Background Jobs & Queues (BullMQ on Redis)

> A queue is two data structures on one Redis instance — a list for "waiting" and a sorted set for "delayed" — plus a Lua script that moves a job between them atomically, so "exactly one worker claims this job" needs no distributed lock.

**Category:** Architecture · Node/Express
**Introduced by:** Phase 7 — `server/src/queue/`, the outbox drain, the scheduled integrity check; extended Phase 10 — `ap-flow-extract`, the first purely event-driven, non-repeatable queue; extended 2026-09-22 — `taxguard-embed`'s in-handler retry and token-budget batching against a rate-limited provider (TaxGuard AI, and its `taxguard-embed` queue, were removed in Phase 29 — the retry/batching mechanism is kept below as the worked example)
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

`captureDocumentService.createApFlowDocument` calls `enqueue()` *after* its `withTransaction` block returns — deliberately outside the transaction, not inside it. That looks, at first glance, like exactly the dual-write problem the transactional outbox ([transactional-outbox.md](transactional-outbox.md)) exists to solve: a Postgres commit and a Redis write are two separate systems, and nothing atomically ties them together. A crash in the gap between them leaves the database saying one thing (`ap_flow_documents.status = 'PENDING'`) and Redis saying nothing happened.

The reason this isn't routed through the outbox is what's actually at stake on either side of that gap. The outbox exists because losing a *financial* event silently — a webhook nobody gets told about, a payment notification that vanishes — is unacceptable, and the cost of the mechanism (a durable event row, a drain process, `FOR UPDATE SKIP LOCKED` claiming) is worth paying for that guarantee. Here, the entire phase posts nothing to the ledger — the worst case of the gap is a document visibly stuck at `PENDING` with no job ever queued for it, which is both visible (the status says so) and repairable by the user themselves (`POST /:id/reextract`, which enqueues fresh). Reaching for the outbox pattern everywhere a Postgres write and a Redis write are adjacent — rather than only where losing the second write silently is genuinely costly — would be solving a problem this phase doesn't have at the price of a mechanism it doesn't need.

### Polling with a high-water mark, and why the mark can only move on a clean pass

Phase 19.3's Drive folder sweep is this codebase's first **incremental poller** — every tick re-checks an external system (Google Drive) for what changed since last time, rather than reacting to an event that's already durable in Postgres the way `webhook-deliver` does. The naive version re-lists everything, every tick, forever; the cheap fix Drive's own API offers is a `modifiedTime >= <cursor>` filter, storing the newest timestamp seen as the floor for next time.

The trap is *when* that floor is allowed to move. A tick that only partially processed what it saw — because a per-file cap truncated the listing, or because one file's download genuinely failed and needs a retry — must **not** advance the cursor past the unprocessed item, or that item is gone forever: the next tick's floor is now *after* it, and nothing will ever list it again.

```ts
const canAdvance = files.length < INTEGRATION_DRIVE_MAX_FILES_PER_SYNC && lastError === null;
const nextCursor = canAdvance ? nextCursorFrom(files) : null;   // null -> COALESCE keeps the old value
```

Both halves of that condition matter for a different reason. `files.length < cap` is the *completeness* check — a raw count at or above the cap means the underlying page might have been cut off before it was exhausted, so there's no way to know whether something newer-but-unlisted exists beyond what was fetched. `lastError === null` is the *cleanliness* check — a transient per-file failure (a flaky download) is deliberately left **unrecorded** rather than marked permanently skipped, specifically so the next tick retries it; advancing the cursor past that tick would silently defeat that retry, since the file would no longer fall inside the next listing's floor. A poller with a cursor is only as correct as its rule for when the cursor is allowed to move, and "only on a batch that was both complete and error-free" is that rule stated precisely.

This differs from a **change-feed** design (Drive's own `changes.list` + a `start_page_token`, or Postgres logical replication) in a way worth being able to name: a change feed hands you *exactly* what changed since a checkpoint, with no re-fetching of the unchanged — genuinely more efficient at scale — but it demands infrastructure the high-water-mark approach doesn't: a durable checkpoint token whose semantics the *provider* defines and can invalidate out from under you, and (for Drive specifically) a feed that is scoped to an entire account rather than one folder, which would mean fetching every change anywhere and filtering client-side — more calls for this specific shape of problem, not fewer. The high-water mark is the right tool exactly when what you're watching is one narrow, filterable slice of a larger system.

### Claim-at-start vs mark-at-end, when polls can overlap

Every scheduled job before Phase 19.3 either ran fast enough that overlap was never a realistic concern (`outbox-drain` every 5s doing simple row-claims) or was naturally self-limiting (`integrity-check` daily). A 60-second poll across many folders, each doing real network I/O, is the first case here where a single sync run can plausibly still be in flight when the *next* tick's sweep would otherwise enqueue the same folder again.

The fix is ordering the "am I allowed to run" check as the **first write**, not a check followed by a write, and not a flag flipped only on success:

```sql
UPDATE integration_drive_folders SET last_synced_at = now()
 WHERE org_id = $1 AND id = $2 AND is_active
   AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(secs => $3))
```

`rowCount === 0` means either the folder wasn't due yet, or another worker already claimed it this window — both are "nothing to do," indistinguishable and both handled the same way, by returning early before any listing happens. This is a **claim-at-start**, not a **mark-at-end**: the alternative — do the work, then stamp `last_synced_at = now()` only once it succeeds — leaves the entire duration of a slow sync unprotected, since nothing has recorded "already claimed" until the work is already done. The single `UPDATE ... WHERE ...` is also why no explicit lock is needed: the row's own `WHERE` predicate, re-evaluated atomically against the current row by Postgres, *is* the lock, in exactly the same "the constraint that would normally require a lock is itself atomic" shape the job-queue's own `wait`-to-`active` transition uses.

### A scheduler's identity lives in Redis, independent of the code that created it

`upsertJobScheduler(schedulerId, ...)` is idempotent *by that id* — restart the worker with the same `schedulerId` and it updates the existing scheduler rather than creating a second one. The corollary, easy to miss, is that renaming the schedule in code (a new `schedulerId` string, or dropping the call to `upsertJobScheduler` entirely because the queue itself got renamed) does **nothing** to the *old* `schedulerId` still sitting in Redis — it has no relationship to the source file that created it beyond having once been written by code that no longer exists. Phase 19.3's queue rename (`ap-flow-drive-sweep` → `integration-drive-sweep`) left exactly this behind: the old scheduler ticks forever, enqueueing jobs onto a queue no worker is listening to, until something explicitly calls `removeJobScheduler` with the old id:

```ts
await new Queue('ap-flow-drive-sweep', { connection: createRedisConnection() })
  .removeJobScheduler('ap-flow-drive-sweep-tick')
  .catch(() => undefined);
```

The general lesson: **a repeatable job's state is data, not code.** Deleting or renaming the code that manages a scheduler is not the same operation as deleting the scheduler — those live in different places, updated by different mechanisms, and a rename migration that only touches TypeScript source has to remember to also clean up the Redis-resident state the old code left behind.

### Retrying inside the handler vs letting the queue retry, and batching to a rate limit

> TaxGuard AI, and the `taxguard-embed` queue this section is about, were removed in Phase 29. The mechanism below is kept as a worked example of "queue-level retry isn't enough" — the reasoning applies to any handler with the same guard-then-terminal-write shape, whether or not this specific queue still exists.

Queue-level retry (`attempts` + `backoff`) re-runs the **whole job**. That only helps if the job is safe to re-run from the start, *and* its own guards let the second run through. `taxguard-embed` (removed in Phase 29) failed the second test. Its handler began with a status guard (`PENDING → PARSING`, a conditional `UPDATE`). On failure it wrote `FAILED`, a terminal state. So every BullMQ retry found the row already past `PENDING` and returned early as a no-op. The guard did exactly what it was written for (duplicate-delivery idempotency, see above), and as a side effect it disabled queue-level retry. A transient provider error was therefore always fatal.

The fix retried at the level of the **unit that failed**, one embeddings request, inside the handler (`embedBatchWithRetry` in `embeddingService.ts`):

- **Classify before retrying.** The HTTP client threw an `EmbeddingsProviderError` with a `retryable` flag. It was true for `429`, `5xx`, and a network/timeout failure (`fetch` rejected), and false for `401/403` and malformed responses. Retrying a bad API key six times just delays the same answer.
- **Capped exponential backoff:** `min(60s, 15s × 2^attempt)`. Voyage sent no `Retry-After` header (checked against a live 429, 2026-09-22), so the delay had to be ours.
- **Opt-in per caller.** Background ingestion passed `{ maxRetries: 6 }`. A question-time query embedding ran inside an HTTP request, and a minute of backoff there is a hung request, so it kept the default of 0 and failed fast.
- **Injectable `sleep`**, so tests asserted the exact backoff schedule without waiting it out.

**Retry alone could not have fixed the real failure.** The account was on Voyage's no-payment-method tier: 3 requests/min and **10K tokens/min**. The handler sent all 64 chunks (~75K tokens) in one request. A single request larger than the per-minute budget is refused however long you wait, so backoff only postpones the same 429. The request had to become smaller than the budget. `batchTexts` therefore closed a batch at 64 inputs **or** 8,000 estimated tokens, whichever came first. A single oversized text was still sent, alone, rather than dropped. Batching by *count* is the usual default, but a rate limit measured in *tokens* needs a batch cap measured in tokens.

A long-sleeping handler doesn't lose its job: BullMQ renews the job lock on a timer while the handler is awaiting (the lock is lost only if the event loop is *blocked*, and `setTimeout`-based sleeping doesn't block it). *Unverified detail: BullMQ's default `lockDuration` is 30 s, renewed at roughly half that interval. Check the docs for the version you use before quoting the numbers.*

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
- `server/src/services/capture/captureDocumentService.ts` — the two `enqueue()` call sites, one deterministic `jobId` (registration), one timestamp-suffixed (re-extraction)

## Gotchas

- **Forgetting `maxRetriesPerRequest: null`.** A worker on an idle queue throws `MaxRetriesPerRequestError` and dies — looks like a Redis outage, isn't one.
- **`'failed'` fires on every attempt, not just the last.** Checking `job.attemptsMade >= configuredAttempts` is required before treating a failure as terminal.
- **`queue.add({ repeat })` on every process start.** Without `upsertJobScheduler`'s idempotency, each restart can add a competing scheduler.
- **Trusting the job payload as data.** A payload is a hint about *what* to process, not a cache of *what it contained* — always re-read from Postgres, both for correctness (data may have changed) and for the tenant-safety property described in `webhookDeliveryService`'s worker-side reads.
- **Forgetting to close `Queue`/`Worker` instances in tests.** Vitest hangs for ~10s reporting a vague "something prevents Vite server from exiting" — the real cause is an open Redis connection.
- **Advancing a poll cursor past a batch that wasn't fully or cleanly processed.** A cap-truncated listing or one file's transient failure both mean "don't move the floor" — moving it anyway makes the unprocessed item permanently invisible to every future tick, not just delayed.
- **A terminal-status guard silently disables queue-level retry.** If a handler marks its row `FAILED` and a retry's first step requires the pre-failure status, every retry is a no-op. Retry the failing unit inside the handler instead, or retry only before the terminal write.
- **A batch bigger than a per-minute budget can never succeed.** Backoff doesn't help a request that exceeds the rate limit on its own. Cap the batch in the limit's own unit (tokens, not items).
- **A queue or scheduler rename in source code is not a rename in Redis.** The old `schedulerId` keeps firing against whatever queue it always targeted until something explicitly calls `removeJobScheduler` on it — renaming the TypeScript constant is necessary but not sufficient.

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

**Q: You added a poller with an incremental cursor. What's the actual rule for when the cursor is allowed to advance, and why?**
A: Only on a batch that was both complete and error-free. Complete means the raw count returned was under whatever page cap was requested — if it hit the cap, there might be more beyond what was fetched, and advancing past that boundary could skip something that exists but was never listed. Error-free means no individual item in the batch failed in a way that left it unrecorded — a transient failure is deliberately not marked done, specifically so the next poll retries it, and moving the cursor forward would push that retry's floor past the very item it's supposed to catch. Get either half wrong and the failure mode isn't a delay, it's silent, permanent data loss — the item just never gets looked at again.

**Q: How is "claim the work" different from "mark the work done," and why does the order matter at a short poll interval?**
A: Claim-at-start means the very first thing that happens is a write that says "I'm taking this," gating everything else on whether that write actually landed. Mark-at-end means the record of having done the work only appears once the work is finished — which leaves the entire duration of the task unprotected, since nothing has claimed it yet. At a slow poll interval that gap never matters because nothing finishes another run's work before the next one starts. Shrink the interval relative to how long the work actually takes, and two runs can genuinely overlap — the second one has no way to know the first is already in flight unless the claim happened before either did any real work. I implemented the claim as one conditional `UPDATE` whose `WHERE` clause encodes "not already claimed this window" — if it updates zero rows, someone else got there first, full stop, no separate check-then-write race to get wrong.

**Q: If you rename a queue in your code, is the old scheduled job actually gone?**
A: No, and that surprised me the first time I hit it. A repeatable job scheduler lives entirely in Redis, identified by a string id you chose — it has no ongoing relationship to the source file that created it. Rename the queue, delete the old handler, ship the change: none of that touches the scheduler already sitting in Redis under its old id. It keeps firing, forever, enqueueing jobs onto a queue nothing consumes anymore, until something explicitly calls `removeJobScheduler` with that exact old id. The lesson is that a scheduler's identity is data, not code — a migration of the code has to remember to also clean up the state the old code left behind, the same way a database migration has to handle existing rows, not just the schema going forward.

**Q: A job calls a third-party API that sometimes returns 429. You have BullMQ `attempts: 5` configured. Is that enough?**
A: Not necessarily, for two reasons we hit in `taxguard-embed` (TaxGuard AI's embedding job, since removed in Phase 29 — the lesson is app-agnostic). First, a queue retry re-runs the whole job, and our handler's idempotency guard (a conditional `PENDING → PARSING` update) meant a retry after the row was marked `FAILED` did nothing. So the queue setting gave no protection at all. Second, a queue retry repeats the whole job, including work that already succeeded. The better place is around the individual call: classify the error (429, 5xx and network errors are retryable; 401 and malformed responses are not), back off exponentially with a cap, and give up after a bounded number of tries with a message that includes the status and the provider's explanation. And only do that in background work. In a request path, fail fast.

**Q: The provider's rate limit is 10K tokens per minute and your retry has exponential backoff up to a minute. Why was it still failing every time?**
A: Because one request was about 75K tokens. The limit applies per request as well as over time: a request larger than the whole per-minute budget is refused no matter when you send it, so backoff only schedules the same refusal later. The fix was on the sending side. Batches now close at a token budget (8K estimated tokens, under the 10K limit) as well as at an item count, so each request can succeed once the window allows. The general rule: cap batches in the same unit the limit is measured in.

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
