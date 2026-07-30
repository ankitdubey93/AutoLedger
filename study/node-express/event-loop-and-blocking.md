# The Node.js Event Loop & What Blocks It

> Node runs your JavaScript on one thread; the event loop is the scheduler that decides which callback runs next, and any CPU-bound work you do inside a callback stalls every other request.

**Category:** Node/Express
**Introduced by:** Phase 0–1 — password hashing with `bcryptjs` on the auth endpoints
**Verified against:** Node 22 / libuv 1.x

---

## Mechanism

Node is single-threaded for *your* JavaScript, but not single-threaded as a process. There is one thread running the V8 isolate and the event loop, plus a `libuv` thread pool, plus internal threads.

### The loop's phases

Each iteration ("tick") of the event loop walks through phases in a fixed order. Each phase has its own callback queue and drains it before moving on:

| # | Phase | What runs |
|---|---|---|
| 1 | **timers** | `setTimeout` / `setInterval` callbacks whose threshold has elapsed |
| 2 | **pending callbacks** | Deferred system-level callbacks (e.g. a TCP `ECONNREFUSED`) |
| 3 | **idle, prepare** | Internal to libuv |
| 4 | **poll** | Retrieves new I/O events and runs their callbacks. **This is where the loop blocks and waits** when there's nothing else to do |
| 5 | **check** | `setImmediate` callbacks |
| 6 | **close callbacks** | `socket.on('close')`, etc. |

### Microtasks interleave between callbacks

Two queues are *not* phases and drain much more aggressively — after **every** callback, and between phases:

1. The `process.nextTick` queue
2. The promise microtask queue (`.then`, `await` continuations)

`nextTick` always drains fully before promises. Both drain completely before the loop advances, which means a recursive `process.nextTick` can starve the loop entirely — the I/O phase never gets reached.

```ts
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));
Promise.resolve().then(() => console.log('promise'));
process.nextTick(() => console.log('nextTick'));
console.log('sync');

// sync → nextTick → promise → timeout → immediate
```

The last two can swap on the very first tick, because whether the timer's 0ms threshold has elapsed depends on how long the loop took to start. This is a classic interview trick question — the honest answer is "`timeout` vs `immediate` ordering is not guaranteed on the first tick; inside an I/O callback `setImmediate` always fires first."

### The libuv thread pool

Default size **4**, configurable with `UV_THREADPOOL_SIZE`. It handles work that has no non-blocking OS primitive:

- Most `fs` operations
- `dns.lookup` (but *not* `dns.resolve`, which uses the network directly)
- `crypto.pbkdf2`, `crypto.scrypt`, `crypto.randomBytes` (async forms)
- `zlib`

**Network I/O does not use the thread pool.** Sockets are handled by `epoll` (Linux) / `kqueue` (macOS) / IOCP (Windows), which is why Node scales to thousands of concurrent connections with a 4-thread pool. A common wrong answer in interviews is "Node uses the thread pool for HTTP requests" — it doesn't.

## Why we chose it here

We didn't choose the event loop, but we do have to live with it, and one of our stack choices interacts badly with it.

`CLAUDE.md` specifies **`bcryptjs`** for password hashing. `bcryptjs` is a *pure JavaScript* bcrypt implementation, so unlike the native `bcrypt` package it does **not** use the libuv thread pool — all of its work happens on the main thread.

| Option | Trade-off | Verdict |
|---|---|---|
| `bcryptjs` (pure JS) | No native build step, works anywhere, but burns main-thread CPU | **Current choice** — chosen for zero-install-friction in Docker |
| `bcrypt` (native) | Async calls run on the libuv thread pool, freeing the loop; needs a compiler toolchain in the image | Worth reconsidering if auth throughput matters |
| `crypto.scrypt` | Built in, thread-pooled, no dependency at all | Strongest option; different algorithm, so it's a migration not a swap |

Its async API is not a no-op, though: `bcryptjs` chunks the hashing rounds and schedules them across `setImmediate`, so it *yields* to the loop between chunks rather than monopolising it in one block. The loop keeps turning — but the CPU is still being spent on the main thread, so throughput still suffers. Using the **sync** API (`hashSync`) is strictly worse: it blocks completely for the full duration.

## Where it lives in this codebase

Nothing is built yet (Phase 0 pending). When auth lands:

- `server/src/services/authService.ts` — the hash/compare calls. Always use the async API, never `hashSync`/`compareSync`.

## Gotchas

- **`hashSync` in a request handler is a self-inflicted outage.** At bcrypt cost factor 10, one hash is tens to low hundreds of milliseconds; in pure JS, slower still. Sync-hashing on a login route means concurrent logins queue behind each other and *every unrelated request* waits too.
- **A recursive `process.nextTick` starves I/O.** The nextTick queue drains before the loop advances, so it never reaches the poll phase. Use `setImmediate` for "yield and continue" work.
- **`await` in a loop serialises.** `for (const x of xs) await f(x)` is sequential; `Promise.all(xs.map(f))` is concurrent. In the ERP context, be deliberate: sequential is sometimes exactly what you want inside a transaction, where interleaving queries on one client would corrupt the batch.
- **CPU-bound work belongs off the main thread.** PDF rendering and payroll batches are why the roadmap puts BullMQ workers in Phase 5 — separate processes, so a heavy job cannot stall the API.
- **`UV_THREADPOOL_SIZE` is read once at startup.** Setting it after the first thread-pool use has no effect.

## Interview Q&A

**Q: Node is "single-threaded" — what does that actually mean?**
A: Your JavaScript executes on a single thread with a single V8 isolate, so two lines of your code never run simultaneously and you get no data races on your own variables. The *process* is multi-threaded: libuv keeps a worker pool (default 4) for filesystem, DNS lookup, some crypto and zlib work, and there are internal threads besides. So "single-threaded" describes the JavaScript execution model, not the process.

**Q: If the thread pool is only 4 threads, how does Node handle 10,000 concurrent connections?**
A: Because network I/O never touches the thread pool. Sockets are registered with the OS event notification mechanism — `epoll` on Linux, `kqueue` on BSD/macOS, IOCP on Windows — and the poll phase asks the kernel which sockets are ready. Waiting on a socket costs a file descriptor, not a thread. The thread pool exists for operations with no non-blocking kernel API, which is mostly the filesystem.

**Q: What's the difference between `process.nextTick` and `setImmediate`?**
A: Despite the names being backwards, `nextTick` fires *sooner*. The nextTick queue drains after the current operation completes and before the event loop continues to its next phase — it isn't a phase at all. `setImmediate` callbacks run in the check phase, so a full loop iteration's worth of I/O gets a chance to run first. Practically: `setImmediate` to yield to I/O, `nextTick` to defer to just after the current stack unwinds. Recursive `nextTick` starves the loop; recursive `setImmediate` doesn't.

**Q: How would you find out that something is blocking the event loop in production?**
A: Measure event loop delay. `perf_hooks.monitorEventLoopDelay()` gives a histogram of how late the loop is running, and `process.hrtime` deltas in a `setInterval` are a poor-man's version. Rising p99 delay with flat CPU-per-request usually means one handler is doing sync work. From there, a CPU profile (`--cpu-prof`, or Clinic Flame) points at the function. Symptomatically: latency degrades across *all* endpoints at once, including ones doing nothing — that's the signature of a blocked loop rather than a slow dependency.

**Q: When would you reach for `worker_threads` versus a separate process?**
A: `worker_threads` for CPU-bound work that needs to share memory cheaply via `SharedArrayBuffer` or transfer large buffers with zero copy — image processing, parsing a big payload. A separate process (or a queue consumer) when the work is independent, needs its own lifecycle, or should survive and retry independently of the API process. For AutoLedger the answer is a separate process: payroll runs and PDF generation go to BullMQ workers, because we want retries, a dead-letter queue, and the ability to scale workers without scaling the API.

**Q: Tell me about a time an architecture decision was shaped by the event loop.**
A: On AutoLedger we standardised on `bcryptjs` rather than native `bcrypt` to keep the Docker image free of a compiler toolchain. That's a pure-JS implementation, so hashing runs on the main thread instead of the libuv pool. The mitigation was a hard rule against the sync API — `hashSync` on a login route would block the loop for the entire hash — and a note to revisit if auth throughput ever becomes the bottleneck, where the real fix is native `bcrypt` or `crypto.scrypt`, both of which are thread-pooled. It's a deliberate trade of throughput for build simplicity, made with the exit route written down.

## Follow-ups they'll dig into

- "You said the poll phase blocks — what decides the timeout it blocks for?" (The nearest timer threshold, or 0 if the check queue is non-empty, or indefinitely if there's nothing pending.)
- "What happens to an unhandled promise rejection?" (Node ≥15 terminates the process by default; `--unhandled-rejections=warn` restores the old behaviour. This is why Express 4 async error handling matters — see the middleware note.)
- "Does `async`/`await` create threads?" (No. It's syntax over promises; continuations are microtasks on the same thread.)

## See also

- [express-middleware-and-async-errors.md](express-middleware-and-async-errors.md)
- `docs/roadmap.md` Phase 5 — why background jobs are a separate process
