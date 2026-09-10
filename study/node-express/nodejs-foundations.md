# Node.js — Foundations

> A JavaScript runtime built from V8 for execution and libuv for async I/O, which trades true parallelism for the ability to hold tens of thousands of idle connections at almost no memory cost.

**Category:** Node/Express · Foundations
**Verified against:** Node 22 (V8 12.x, libuv 1.x)

---

## What it is

A server-side JavaScript runtime, created by Ryan Dahl in 2009. Not a language, not a framework — a runtime that packages four things:

1. **V8** — Google's JavaScript engine, which compiles and executes your code.
2. **libuv** — a C library providing the event loop, a thread pool, and a cross-platform abstraction over async I/O (`epoll` on Linux, `kqueue` on BSD/macOS, IOCP on Windows).
3. **C++ bindings** — the bridge exposing libuv and OS capabilities to JavaScript.
4. **The standard library** — `fs`, `http`, `stream`, `crypto`, `net`, written partly in JS and partly in C++.

Dahl's founding argument was that the dominant server model of the time — a thread or process per connection — wasted memory on threads that were merely *waiting*. Node's answer: one thread, non-blocking I/O, and callbacks.

## How it works

### V8: how your JavaScript actually runs

JavaScript isn't interpreted line by line. V8 runs a tiered pipeline:

- **Parser** → AST
- **Ignition** — a bytecode interpreter; starts fast, runs everything
- **Sparkplug** — a baseline compiler producing unoptimised machine code quickly
- **Maglev / TurboFan** — optimising compilers that kick in for hot functions, using runtime type feedback to generate specialised machine code

Two mechanisms make dynamic JS fast:

- **Hidden classes (maps).** V8 gives objects with the same shape a shared internal descriptor, so property access compiles to a fixed memory offset rather than a hash lookup. **Adding properties in a different order creates a different hidden class** — which is why consistent object shapes are a genuine performance concern.
- **Inline caches.** A property access site remembers the shape it saw last time. Same shape → fast path. Feed a function many different shapes and the site becomes "megamorphic" and deoptimises.

**Garbage collection** is generational: a small **young generation** collected frequently by a cheap copying scavenger (most objects die young), and an **old generation** collected by mark-sweep-compact, run incrementally and partly concurrently to limit pause times. The heap is bounded — tune with `--max-old-space-size`. GC pauses are a latency source: they run on the main thread and block your JavaScript.

### libuv and the concurrency model

Your JavaScript runs on **one thread**. When you make an I/O call, Node hands it to libuv, registers a callback, and returns immediately. Waiting on a socket costs a file descriptor and a closure — not a thread with its own stack. That's the whole performance argument: a threaded server pays ~1MB of stack per connection; Node pays a few hundred bytes.

libuv also keeps a **thread pool (default 4, set via `UV_THREADPOOL_SIZE`)** for work with no non-blocking kernel API: most `fs` operations, `dns.lookup`, async `crypto` (`pbkdf2`, `scrypt`, `randomBytes`), and `zlib`. **Network I/O does not use it** — that's the kernel event notification mechanism directly.

The trade is stark and worth stating plainly: **concurrency without parallelism.** Node handles many things at once, but executes only one at a time. CPU-bound work therefore blocks *everything*. Full phase-by-phase detail: [event-loop-and-blocking.md](event-loop-and-blocking.md).

### Modules: two systems that don't quite agree

| | CommonJS | ES Modules |
|---|---|---|
| Syntax | `require` / `module.exports` | `import` / `export` |
| Resolution | Synchronous, at call time | Asynchronous, statically analysed upfront |
| Timing | Can `require` conditionally mid-function | Imports hoisted; graph resolved before execution |
| Live bindings | No — you get a copy of the value | Yes — bindings update |
| Top-level `await` | No | Yes |
| `__dirname` | Available | Use `import.meta.dirname` |

CommonJS wraps each file in a function receiving `exports`, `require`, `module`, `__filename`, `__dirname` — which is why those look like globals but aren't. Chosen per file by `.mjs`/`.cjs` extension or `"type": "module"` in `package.json`. **ESM can import CommonJS; CommonJS cannot statically `require` ESM** (only `await import()`). This mismatch is the source of most "Cannot use import statement outside a module" pain.

### Streams: the abstraction people skip

Streams process data in chunks rather than loading it whole, and carry **backpressure** — if the consumer is slower than the producer, `write()` returns `false` and the producer should pause. `pipe()` and `stream.pipeline()` wire this automatically; hand-rolled `data` handlers usually don't, which is how a service reading a large file OOMs. Relevant to us for document uploads and streamed downloads (Phase 9.5 — see [../architecture/file-storage-and-streaming.md](../architecture/file-storage-and-streaming.md) for the mandatory `'error'` listener a bare `pipe()` doesn't give you) and `.pptx` generation (Phase 15).

### Using more than one core

One Node process uses one core for JavaScript. To use the rest: the `cluster` module (forks workers sharing a listening socket), a process manager, or a container orchestrator running N replicas. For CPU-bound work inside one process, `worker_threads`.

## What it does best, and how

**I/O-bound concurrent workloads** — REST APIs, gateways, proxies, real-time servers. The mechanism is the one above: an idle connection costs a file descriptor plus a callback rather than a thread and its stack, so memory per connection is one to three orders of magnitude smaller than a thread-per-connection server. For an API whose time is dominated by waiting on a database, this is close to ideal.

**One language across the whole stack.** Not just convenience — shared types. With TypeScript we can define a journal-entry payload once and have the compiler check both the Express handler that receives it and the React form that sends it. Validation logic, money formatting, and domain constants are written once.

**Fast iteration and ecosystem reach.** npm is the largest package registry in existence; almost any integration has a maintained client. That cuts both ways — see below.

**Streaming and glue work.** The stream abstraction with real backpressure makes Node strong at moving and transforming data — proxies, file pipelines, log processing.

## Where it's weak

- **CPU-bound work.** Image processing, big-number crunching, synchronous crypto — all block the loop and stall every concurrent request. Needs `worker_threads` or separate processes.
- **No parallelism by default.** Multi-core needs explicit clustering or multiple replicas.
- **Single-threaded means a single point of failure.** One uncaught synchronous throw or unhandled rejection can take down the process serving all in-flight requests.
- **Dependency surface.** Large transitive trees are a real supply-chain and audit burden.
- **Numeric limits.** One `number` type, IEEE 754 doubles, exact integers only to 2⁵³−1 — a genuine constraint for financial data. `BigInt` exists but doesn't serialise to JSON.
- **Memory ceiling.** The V8 heap is bounded and GC pauses are main-thread work.

## Why we chose it for AutoLedger

| Requirement | Why Node |
|---|---|
| Workload is almost entirely DB-bound | Non-blocking I/O is exactly the right model |
| React frontend, shared domain types | One language, one type definition, checked both ends |
| Background jobs (payroll, PDFs, depreciation) | BullMQ workers as separate processes — CPU work off the API |
| Small team, fast iteration | Ecosystem maturity for Postgres, JWT, PDF, S3 |

**Versus Go:** genuine parallelism, lower memory, no GC pauses of consequence, better for CPU-bound work. We'd lose the shared-language/shared-types benefit with the React client, which for a form-heavy ERP is a large practical win.

**Versus Java/Spring or .NET:** more mature enterprise ERP tooling and true threading. Heavier, slower to iterate, larger operational footprint.

**The honest caveat:** the money constraint above is real. Because JS integers are exact only to 2⁵³−1 and `pg` returns `BIGINT` as a *string*, careless code can concatenate instead of add. That's precisely why `docs/guardrails.md` rule 3 mandates integer cents with conversion in one module — the runtime choice created a hazard, and the guardrail contains it.

## Vocabulary that shows up in interviews

**event loop** · **libuv** · **V8** · **hidden class / inline cache** · **thread pool** · **non-blocking I/O** · **backpressure** · **microtask queue** · **CommonJS vs ESM** · **`worker_threads`** · **`cluster`** · **generational GC** · **concurrency vs parallelism**

## Interview Q&A

**Q: What is Node.js, and what is it not?**
A: It's a runtime that pairs V8 for executing JavaScript with libuv for asynchronous I/O, plus C++ bindings and a standard library. It is not a language and not a framework — Express is a framework that runs on it. The defining design choice is a single-threaded event loop over non-blocking I/O, which came from the observation that thread-per-connection servers spend most of their memory on threads that are only waiting.

**Q: Explain concurrency versus parallelism in Node.**
A: Node is concurrent but not parallel for your JavaScript. It can have thousands of operations in flight, because each waiting socket costs a file descriptor and a callback rather than a thread. But only one piece of your JavaScript executes at any instant. So Node handles ten thousand simultaneous database queries comfortably and handles two simultaneous image resizes terribly — the second blocks the first and everything else. Parallelism requires `worker_threads` or multiple processes.

**Q: How does V8 make dynamically-typed JavaScript fast?**
A: Two main techniques on top of a tiered compilation pipeline. Hidden classes: V8 assigns objects with identical shapes a shared internal descriptor, so property access becomes a fixed offset instead of a hash lookup — which is why constructing objects with consistent key order matters. Inline caches: each property-access site caches the shape it last saw, so repeat access takes a fast path. Then hot functions get promoted from the bytecode interpreter to an optimising compiler that specialises machine code against observed types. When those assumptions break — a function suddenly receiving a different shape — V8 deoptimises back down.

**Q: When would you *not* choose Node?**
A: When the work is CPU-bound rather than I/O-bound — video transcoding, heavy numerical simulation, cryptographic batch work. You can push it to worker threads, but at that point you're fighting the model, and Go, Rust, or a JVM language give you real parallelism for free. I'd also hesitate where exact decimal arithmetic is pervasive, because there's one number type and it's a float; you can work in integer minor units, as we do, but a language with a native decimal type removes the hazard rather than containing it.

**Q: CommonJS versus ES modules — what actually differs?**
A: CommonJS resolves synchronously at call time, so you can require conditionally inside a function, and you get a copied value rather than a live binding. ESM is statically analysed: the whole import graph is resolved before any code runs, which enables tree-shaking and top-level `await`, and exports are live bindings. Practically the friction is directional — ESM can import CommonJS, but CommonJS can't statically require ESM, only `await import()` it. That asymmetry is behind most module errors people hit when adopting a modern dependency.

**Q: What happens if an exception goes unhandled?**
A: A synchronous throw that escapes to the top emits `uncaughtException`; with no handler, the process prints the stack and exits. An unhandled promise rejection terminates the process by default since Node 15 — it used to be a warning. That's directly relevant to Express 4: an `async` handler that throws produces a rejection nobody awaits, so it can kill the process serving every other in-flight request. The correct posture is to catch at the boundary — an `asyncHandler` wrapper routing to the error middleware — and treat `uncaughtException` purely as a last-resort logger before a deliberate restart, never as recovery, because the process state is unknown at that point.

**Q: Tell me about a time the runtime's characteristics shaped a design decision.**
A: Two on AutoLedger. First, all CPU-heavy work — payroll batch runs, PDF invoice rendering, nightly depreciation — is architected as BullMQ jobs in separate worker processes rather than inline in request handlers, specifically because a long synchronous computation on the event loop degrades every unrelated endpoint at once. Second, money is integer cents with a single conversion module, because JavaScript has one number type and it's a float, and `pg` hands back `BIGINT` as a string. Both are cases where the design is downstream of runtime facts rather than preference.

## Follow-ups they'll dig into

- "How would you profile a memory leak in Node?" (Heap snapshots via `--inspect` and Chrome DevTools; compare retained sizes across snapshots; usual culprits are unbounded caches, unremoved listeners, closures over large objects.)
- "What does `cluster` do that a load balancer doesn't?" (Shares one listening socket across forked workers so the OS distributes connections; still one machine, no cross-machine failover.)
- "Why is `JSON.parse` on a huge payload a problem?" (Synchronous and unbounded — blocks the loop and spikes the heap. Stream-parse or cap body size.)
- "How do you implement graceful shutdown?" (`SIGTERM` → stop accepting new connections, finish in-flight requests, drain the pool, then exit; needed for zero-downtime container deploys.)

## See also

- [event-loop-and-blocking.md](event-loop-and-blocking.md)
- [express-foundations.md](express-foundations.md)
- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md)
