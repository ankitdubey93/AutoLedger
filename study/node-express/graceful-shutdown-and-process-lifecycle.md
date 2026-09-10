# Graceful Shutdown & the Node Process Lifecycle

> A Node process dies instantly on SIGTERM unless you take over the signal — and for a financial API, "instantly" means killing in-flight transactions mid-flight.

**Category:** Node/Express
**Introduced by:** Phase 0 — `server/src/index.ts`. Extended Phase 7 — `server/src/worker.ts`, a second process with the same discipline
**Verified against:** Node 24.4.1 (defaults below read off `http.createServer()` at runtime), Express 5.2, `pg` 8.22, `bullmq` ^6.3.4

---

## Mechanism

### What a signal actually does

`SIGTERM` and `SIGINT` are POSIX signals: the kernel interrupts the process and runs the disposition for that signal. For both, the **default disposition is immediate termination**. Nothing is flushed, no callback runs, sockets are reset by the OS.

Node changes this only if you attach a listener. `process.on('SIGTERM', …)` installs a libuv signal handler, which converts the signal into an event on the event loop and **suppresses the default action**. That is the whole trick — and it also means the process now has no automatic exit path, so if your handler never calls `process.exit()`, `SIGTERM` stops working entirely and you have built an unkillable process. That is the single most common way this goes wrong.

Signals you cannot intercept: `SIGKILL` (`kill -9`) and `SIGSTOP`. The kernel handles them without consulting the process.

Exit codes encode this: a process killed by signal *n* reports `128 + n`. `SIGTERM` is 15, so **143** means "died to an unhandled SIGTERM" and **130** (128+2) means "died to Ctrl-C". Seeing 143 in a container log is proof your shutdown handler did not run.

### Who sends what

| Trigger | Signal | Grace period before SIGKILL |
|---|---|---|
| `docker stop` | SIGTERM | 10s default (`--time`) |
| Kubernetes pod delete | SIGTERM | 30s default (`terminationGracePeriodSeconds`) |
| Ctrl-C in a terminal | SIGINT to the **whole foreground process group** | none |
| `systemctl stop` | SIGTERM | 90s default |

Ctrl-C going to the process group, not one process, is why interactive development hides signal-forwarding bugs — see Gotchas.

### The drain sequence

Order matters, and each step exists for a reason:

```ts
const closed = new Promise<void>((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()));
});
server.closeIdleConnections();
await closed;
await pool.end();
process.exit(0);
```

1. **`server.close()`** stops the listening socket from accepting new connections, then invokes its callback *once every existing connection has ended*. It does **not** touch existing connections — that is the "graceful" part, and also the reason a naive implementation appears to hang.

2. **`server.closeIdleConnections()`** (Node ≥ 18.2) is what stops the hang. HTTP keep-alive means a browser holds its TCP connection open after a response, expecting to reuse it. Those connections are open but idle, and `close()` waits for them. Evicting the idle ones — while leaving connections with a request in flight alone — lets `close()` complete in milliseconds instead of waiting out the keep-alive timeout. Our measured drain is **9 ms**. Its blunter sibling, `closeAllConnections()`, destroys sockets mid-request and is what you call in the force-exit path, not the graceful one.

3. **`pool.end()` last.** It waits for checked-out `pg` clients to be released and closes every socket. Doing this *before* HTTP is drained would pull the database out from under a request that is still running — the exact failure the shutdown was meant to avoid.

4. **The force-exit timer.**

```ts
const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
forceExit.unref();
```

`unref()` removes the timer from the event loop's reference count, so its existence never keeps the process alive. Without it, a clean shutdown that finishes in 9 ms would still sit for the full 10 seconds waiting for a timer whose only job is to handle failure. This is the general rule for any "watchdog" timer.

The timeout must be **shorter than the supervisor's grace period**. Ours is 10s against Docker's 10s default — deliberately not longer, because if we outlast the supervisor, SIGKILL wins and the timer is decoration.

### The timeouts that shape draining

Read off a fresh `http.createServer()` on Node 24.4.1:

| Property | Default | Meaning |
|---|---|---|
| `keepAliveTimeout` | 5000 ms | How long an idle keep-alive socket is held open |
| `headersTimeout` | 60000 ms | Time allowed to receive the complete request headers |
| `requestTimeout` | 300000 ms | Time allowed for the entire request |

We tighten the first two to 5s and 10s. Lower `keepAliveTimeout` shortens the worst-case drain and reduces sockets parked on the server; `headersTimeout` at 60s is generous enough to be a slowloris budget.

One deployment caveat: if a load balancer sits in front, its idle timeout should be **lower** than the server's `keepAliveTimeout`. If the server closes a socket the LB still believes is reusable, the LB sends a request into a closing connection and the client sees a sporadic 502. Whoever closes first should be the one that knows.

### Why `unhandledRejection` and `uncaughtException` exit

Both handlers log and then drain with exit code 1 rather than resuming. After an uncaught exception the process is in an **unknown state**: a `finally` may not have run, so a `pg` client may be checked out with an open `BEGIN` and no `COMMIT` or `ROLLBACK`. Continuing to serve financial requests from a process in that condition is worse than restarting. Note that since Node 15, an unhandled rejection is fatal by default anyway — installing the handler buys the chance to drain first, not the chance to continue.

The exception is a *bounded* failure like a bad request; that is `ApiError` through the error middleware, and never reaches here.

### The worker process: draining a job, not a request

`server/src/worker.ts` (Phase 7) is a second, independent process consuming BullMQ queues, and it needs the same lifecycle discipline as the API server — but the *thing being drained* is different in a way worth being precise about.

```ts
export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
  await closeQueues();
}
```

`Worker#close()` stops the worker from pulling *new* jobs off the queue, then waits for whatever job is **currently executing** to finish — the direct analogue of `server.close()` waiting out in-flight HTTP requests rather than cutting them off. The asymmetry with the HTTP case is concurrency shape: a worker's `concurrency: 5` option means up to five jobs can be genuinely in flight at once on one worker instance, so `close()` is waiting for a *set* of async handlers to settle, not one request. There is no `closeIdleConnections()` equivalent needed here — a worker with nothing to do simply isn't holding anything open the way an idle keep-alive socket is.

Shutdown order mirrors the API server's reasoning exactly: workers close (stop taking new work, finish what's running) *before* `closeQueues()` tears down the Redis connections, and both happen before `closePool()` — a job mid-`withTransaction` must be allowed to reach its own `COMMIT`/`ROLLBACK` before the database connection it's using disappears. The same unref'd force-exit timer pattern applies, at the same `SHUTDOWN_TIMEOUT_MS`, so a hung job handler bounds the worker's shutdown exactly as a hung request bounds the API's.

### What happens to a job whose process is `SIGKILL`ed mid-run

This is the case graceful shutdown *can't* cover — `SIGKILL` bypasses every handler, so `worker.close()` never runs and the in-flight job's completion is simply never recorded. BullMQ's answer isn't a shutdown-time mechanism at all; it's a standing one. A job in the `active` list carries a **lock**, renewed periodically by the worker while it runs; a `SIGKILL`ed process stops renewing it, and once the lock expires, BullMQ's maintenance routine notices the stale lock and moves the job back to `wait` (or to `failed`, if it's already spent its retries) for another worker to pick up. This is the same at-least-once guarantee [background-jobs-and-queues.md](../architecture/background-jobs-and-queues.md) describes for an ordinary retry — from the queue's point of view, "the process was killed mid-job" and "the job legitimately failed" look identical, which is exactly why every handler here is written to be safely re-run rather than relying on graceful shutdown as its only correctness guarantee. Graceful shutdown reduces *how often* this reclaim path fires; it can't be the only thing standing between a `SIGKILL` and a lost or duplicated job.

## Why we chose it here

The prior build had no shutdown handling at all. It didn't visibly hurt, because nothing about a single-user bookkeeping app made a truncated request expensive. That changes the moment a request spans `BEGIN … COMMIT` across several tables: killed mid-transaction, PostgreSQL rolls back when the connection drops, which is *correct* — but the client got no response and does not know whether it committed. Under a retry, that is a double-posted journal entry.

Graceful shutdown is therefore the first half of a pair. The second is the Phase 17 idempotency-key middleware, which makes the retry safe. Draining reduces how often the ambiguity happens; idempotency keys make it harmless when it does. Neither replaces the other.

| Option | Trade-off | Verdict |
|---|---|---|
| No handler (prior build) | Simple. Truncates in-flight work; exit 143 | Rejected |
| `server.close()` only | Correct but appears to hang for the keep-alive timeout on every restart | Rejected — the hang gets it removed |
| `close()` + `closeIdleConnections()` + `pool.end()` + unref'd force-exit | ~20 lines, drains in 9 ms, bounded worst case | **Chosen** |
| A library (`stoppable`, `terminus`) | Adds health-check and readiness wiring | Rejected — a dependency for 20 lines we should understand |

Related: [guardrails.md](../../docs/guardrails.md) rule 5 (transaction safety) is what shutdown protects, and rule 5's "no post-`COMMIT` follow-up work" is the same concern from the other direction — work queued after a commit is work a shutdown can lose.

## Where it lives in this codebase

- `server/src/index.ts` — the whole lifecycle: `listen`, timeout tuning, `shutdown()`, the four `process.on` handlers
- `server/src/db/connect.ts` — `closePool()`, and the `pool.on('error')` listener that keeps an idle-client failure from crashing the process
- `server/src/config/constants.ts` — `SHUTDOWN_TIMEOUT_MS`
- `server/src/__tests__/health.test.ts` — `afterAll` closes the pool, or Vitest hangs on exit for exactly the same reason
- `server/src/worker.ts` — the worker process entry point, mirroring `index.ts` line for line: same latch, same unref'd force-exit timer, same four `process.on` handlers
- `server/src/queue/worker.ts` — `startWorkers()`/`stopWorkers()`, where the drain actually happens

## Gotchas

- **`npm run dev` does not forward signals.** Verified while building Phase 0: `kill -TERM` on the `npm` process left the `tsx` child and *its* node grandchild alive, still holding port 5000. The next start failed with `EADDRINUSE`, and — worse — health checks kept passing against the orphan, so a test appeared to succeed while the log file it should have written was empty. Ctrl-C hides this because SIGINT goes to the whole process group. In production, run `node dist/index.js` as PID 1, not through npm.
- **PID 1 has no default signal dispositions.** In a container, a process running as PID 1 does *not* die by default on SIGTERM — the kernel ignores signals with no installed handler for PID 1. So a container without a shutdown handler often waits the full 10 seconds and gets SIGKILLed. Either install the handler (we do) or use `docker run --init` / `tini`.
- **A guard flag is required.** Two Ctrl-Cs, or SIGTERM followed by SIGINT, would otherwise restart the sequence mid-drain and double-call `pool.end()`. Hence `if (shuttingDown) return;`.
- **`process.exit()` truncates async stdout.** When stdout is a pipe (not a TTY), writes are asynchronous and `process.exit()` discards what's buffered — the reason a final log line vanishes in a container but appears in your terminal. Setting `process.exitCode` and letting the loop drain naturally avoids it; we use `process.exit()` deliberately, because we want a hard bound, and accept that the last line is best-effort.
- **Forgetting `unref()`** turns every clean shutdown into a full-timeout wait.
- **Draining is not zero-downtime.** Between the socket closing and the replacement accepting, requests fail. Zero downtime needs a readiness probe that fails *before* SIGTERM arrives, so the load balancer stops sending traffic first. That's orchestration work, not process work — and it is not built here.

## Interview Q&A

**Q: What happens when a Node process receives SIGTERM?**
A: By default it terminates immediately — the default disposition for SIGTERM is termination, and nothing is flushed. The exit status is 128+15 = 143. If you attach a `process.on('SIGTERM')` listener, libuv converts the signal into an event loop event and suppresses the default action, which means the process will now *not* exit unless your handler makes it. That's the part people miss: adding a handler without an exit path creates a process that ignores SIGTERM.

**Q: Why isn't `server.close()` enough on its own?**
A: `close()` stops the listener accepting new connections and fires its callback when all existing connections have ended — but it deliberately doesn't touch existing ones. With HTTP keep-alive, browsers hold idle connections open for reuse, so `close()` waits for them and shutdown looks hung for the length of the keep-alive timeout. You also need `server.closeIdleConnections()`, which evicts the idle sockets while leaving in-flight requests alone. In our server that's the difference between waiting seconds and draining in 9 ms.

**Q: What order do you close things in, and why does the order matter?**
A: HTTP first, database second. Stop accepting connections, evict idle sockets, wait for in-flight requests to finish, *then* end the connection pool. If you call `pool.end()` first you rip the database out from under requests that are still running — causing exactly the truncated work that graceful shutdown exists to prevent. Anything with a queue or an external connection closes after the thing that feeds it.

**Q: Why do you exit on `uncaughtException` instead of logging and carrying on?**
A: Because after an uncaught exception the process state is unknown. In our case the specific risk is a `pg` client checked out with an open transaction whose `finally` never ran — so a connection is leaked and a `BEGIN` is dangling. A pool of ten connections leaks to exhaustion and the API dies anyway, just later and more confusingly. Logging, draining and exiting non-zero lets the supervisor restart into a known-good state. Since Node 15 an unhandled rejection is fatal by default regardless; the handler exists so we can drain first rather than to keep running.

**Q: How do you pick the shutdown timeout?**
A: Shorter than whatever the supervisor will wait before SIGKILL, because past that point the timer is decoration. Docker's default `docker stop` grace is 10s and Kubernetes' `terminationGracePeriodSeconds` is 30s, so we use 10s and would raise it only alongside the orchestrator setting. And the timer must be `unref()`'d, or a clean shutdown still waits the full duration for a timer that only exists for the failure case.

**Q: Does graceful shutdown give you zero-downtime deploys?**
A: No, and conflating the two is a common mistake. Draining stops you from *truncating* work that's already in progress. Zero downtime is about not *receiving* work you can't serve, which needs a readiness probe that starts failing before SIGTERM is sent, so the load balancer removes the instance while it's still healthy enough to finish what it has. Draining is a process concern; zero downtime is an orchestration concern. We have the first and not the second.

**Q: Tell me about a time a shutdown detail bit you.**
A: Building the Phase 0 scaffold I tested SIGTERM by killing the `npm run dev` process, and got exit 143 with an empty log — as if my handler didn't exist. It did; npm just doesn't forward signals to its child, so the `tsx` process and its node grandchild survived and kept holding port 5000. What made it genuinely misleading was that my curl health check *passed* — it was talking to the orphan from the previous run, not the process I'd just started, which had failed to bind and written nothing. Two lessons: signal-test against the real process (`node dist/index.js`), not through a wrapper; and treat "the assertion passed but the log is empty" as evidence you're talking to something other than what you think.

## Follow-ups they'll dig into

- "Your instance is behind an ALB with a 60s idle timeout and your `keepAliveTimeout` is 5s. What breaks?" — the server closes sockets the LB thinks are reusable, producing intermittent 502s. The LB's idle timeout must be the lower of the two.
- "A request takes 30 seconds and your drain timeout is 10. What happens?" — force-exit kills it. Either the timeout accommodates your real p99, or long work belongs in a queue (Phase 7) rather than a request.
- "Your worker gets SIGKILLed mid-job. What happens to the job?" — nothing runs, because SIGKILL bypasses every handler; BullMQ's own lock-expiry mechanism (not a shutdown-time one) reclaims it once the job's lock lapses, and it retries elsewhere — which is also why handlers must be idempotent, not just gracefully-shut-down.
- "How would you test this?" — spawn the built process, hold an in-flight request open, signal it, assert the response completes and the exit code is 0. Signal the actual node process, not npm.
- "What if the shutdown handler itself throws?" — the `catch` exits 1, and the unref'd timer is the backstop if it hangs instead of throwing.
- "You're running in Kubernetes and see 143s in the logs anyway." — likely PID 1 with no handler, a grace period shorter than the drain, or npm/shell in the entrypoint swallowing the signal.

## See also

- [event-loop-and-blocking.md](event-loop-and-blocking.md) — how signal events are dispatched, and why a blocked loop can't drain
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — what a checked-out client with an open transaction costs
- [../architecture/stack-overview-request-lifecycle.md](../architecture/stack-overview-request-lifecycle.md) — the request path being drained
- [../architecture/background-jobs-and-queues.md](../architecture/background-jobs-and-queues.md) — the worker process, retry, and lock-expiry reclaim mechanism this note's new section draws on
