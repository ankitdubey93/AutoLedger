# Study Notes — Backend / React + Node.js + TypeScript Interviews

Interview preparation generated from what AutoLedger actually builds. Every note is anchored to a real decision in this codebase, which is the point: "we chose X over Y because Z" is what makes an answer memorable rather than recited.

**How to use these:** read the *Mechanism* section for depth, the *Why we chose it here* section for the story you'll actually tell, and drill the *Interview Q&A* out loud. The **Follow-ups** section is where candidates get caught — those are the second and third questions after your first answer lands.

Writing convention and the standing obligation to add notes: [`docs/study-notes.md`](../docs/study-notes.md). Start a new note from [`TEMPLATE.md`](TEMPLATE.md).

---

## Notes

Two genres, deliberately distinct. **Foundations** notes answer "what is this technology, how does it work, where is it weak" — the opening five minutes of an interview. **Concept** notes are the deep-dives on one mechanism, following [TEMPLATE.md](TEMPLATE.md). Read the foundations note first when a topic is new to you, then the concept note for depth.

### Foundations

| Note | Covers |
|---|---|
| [architecture/stack-overview-request-lifecycle.md](architecture/stack-overview-request-lifecycle.md) | **Start here.** One request — a saved journal entry — traced end to end through all five technologies. The answer to "walk me through your stack" and "what happens when a user clicks save" |
| [node-express/nodejs-foundations.md](node-express/nodejs-foundations.md) | V8 vs libuv, the concurrency trade, CJS/ESM, streams & backpressure, using more than one core, where Node is weak |
| [node-express/express-foundations.md](node-express/express-foundations.md) | Wrapping `http`, the router as an ordered layer stack, arity-based error detection, the Express 4 async gap, why it supplies no architecture |
| [react/react-foundations.md](react/react-foundations.md) | JSX as function calls, reconciliation, Fiber and interruptible rendering, why the hook rules exist, state updates & re-renders, context cost, React 19 additions |
| [typescript/typescript-foundations.md](typescript/typescript-foundations.md) | Compiler pipeline, erasure and its exceptions, structural typing, inference & narrowing, `any` vs `unknown`, what `strict` buys, generics, `satisfies` |
| [postgresql/postgresql-foundations.md](postgresql/postgresql-foundations.md) | Process-per-connection, heap/TOAST storage, WAL and crash recovery, MVCC, the query pipeline, all six index types, extensibility |

### Node & Express

| Note | Covers |
|---|---|
| [event-loop-and-blocking.md](node-express/event-loop-and-blocking.md) | Loop phases, microtask queues, `nextTick` vs `setImmediate`, libuv thread pool, why network I/O doesn't use it, `bcryptjs` blocking the main thread |
| [express-middleware-and-async-errors.md](node-express/express-middleware-and-async-errors.md) | Router layer stack, `next()` closure, arity-based error-middleware detection, the Express 4 async-throw trap, middleware ordering |

### TypeScript

| Note | Covers |
|---|---|
| [branded-types-for-money.md](typescript/branded-types-for-money.md) | IEEE 754 and why floats can't hold money, integer cents, `BIGINT` vs `NUMERIC`, structural vs nominal typing, branding with `unique symbol`, branded IDs for tenant safety |

### PostgreSQL

| Note | Covers |
|---|---|
| [transactions-isolation-pooling.md](postgresql/transactions-isolation-pooling.md) | Session-per-connection, why `pool.query` escapes a transaction, MVCC, all four isolation levels, lost update, `FOR UPDATE`, deadlocks, `BIGINT`-as-string |

### Architecture

| Note | Covers |
|---|---|
| [multi-tenancy-row-level-scoping.md](architecture/multi-tenancy-row-level-scoping.md) | Row-level vs schema-per-tenant vs database-per-tenant, Postgres RLS as a backstop, why `user_id` was the wrong boundary, cross-tenant isolation testing |
| [stack-overview-request-lifecycle.md](architecture/stack-overview-request-lifecycle.md) | End-to-end request trace; the layering rule and how to test that the boundary is real (also listed under Foundations) |

### React

Foundations only so far — see [react/react-foundations.md](react/react-foundations.md). Concept notes arrive with Phase 1's auth UI, when there is real client code to anchor them to.

### Security & Auth

*No notes yet — arrives with Phase 1.*

---

## Coverage tracker

What's owed as the build progresses. The gap is recorded here rather than as a placeholder file.

**✅** covered by a dedicated note · **◐** covered at foundations level only, deep-dive still owed when the phase lands · **⬜** not covered.

### Node & Express

| Topic | Phase | Status |
|---|---|---|
| Event loop, microtasks, thread pool | 0–1 | ✅ |
| Middleware chain, async error handling | 0–1 | ✅ |
| Streams & backpressure | 9 (PDF), 14 (uploads) | ◐ |
| `worker_threads` vs child processes vs queue consumers | 5 | ◐ |
| Graceful shutdown, connection draining, `SIGTERM` | 0 | ⬜ |
| `AsyncLocalStorage` for request context | 4 (audit actor) | ⬜ |
| BullMQ: queues, workers, retries, DLQ, idempotent jobs | 5 | ⬜ |
| Cron scheduling & idempotent batch jobs | 11–12 | ⬜ |

### TypeScript

| Topic | Phase | Status |
|---|---|---|
| Branded types, structural vs nominal typing | 2 | ✅ |
| Declaration merging (`req.user`) | 1 | ◐ |
| Discriminated unions for FSM state | 8 | ◐ |
| Generics & constrained type parameters | 2 | ✅ |
| `unknown` vs `any`, type guards, narrowing | 1 | ✅ |
| Utility types (`Pick`, `Omit`, `Partial`, `Record`) | 2 | ◐ |
| Conditional & mapped types | later | ⬜ |
| `satisfies`, `as const`, literal inference | 2 | ✅ |
| `strict` mode: what each flag actually buys | 0 | ✅ |

### PostgreSQL

| Topic | Phase | Status |
|---|---|---|
| Transactions, isolation, pooling | 1–2 | ✅ |
| Index types: B-tree, GIN, GiST, partial, covering | 2+ | ✅ |
| `EXPLAIN ANALYZE` and reading a query plan | 2+ | ◐ |
| Constraints: CHECK, UNIQUE, EXCLUDE, deferrable | 1–2 | ◐ |
| Triggers & `updated_at`; CDC audit snapshots | 4 | ⬜ |
| `WITH RECURSIVE` CTEs + cycle detection | 10 | ⬜ |
| Window functions (running balances, ledger reports) | 3 | ⬜ |
| `EXCLUDE USING GIST` + `btree_gist` for date ranges | 11 | ⬜ |
| `JSONB`: operators, indexing, when *not* to use it | 12 | ◐ |
| `pg_trgm` fuzzy search | 12 | ⬜ |
| Partitioning strategies | later | ⬜ |
| Migration design: additive, idempotent, zero-downtime | 0–1 | ⬜ |

### React

| Topic | Phase | Status |
|---|---|---|
| Reconciliation, keys, render triggers | 1 | ✅ |
| Hook rules and why they exist (the call-order model) | 1 | ✅ |
| `useEffect` dependency array, cleanup, double-invoke in StrictMode | 1 | ◐ |
| Context: composition, re-render cost, splitting providers | 1 | ✅ |
| `useMemo` / `useCallback` / `React.memo` — when they actually help | 2 | ◐ |
| Data fetching, races, cancellation, cache invalidation on org switch | 1–2 | ◐ |
| Controlled vs uncontrolled forms | 2 | ◐ |
| React 19 specifics (`use`, Actions, compiler) | 1 | ◐ |
| Error boundaries & suspense | 2 | ◐ |

### Architecture & patterns

| Topic | Phase | Status |
|---|---|---|
| Multi-tenancy isolation strategies | 1 | ✅ |
| Double-entry bookkeeping as an invariant system | 2 | ⬜ |
| Append-only ledgers vs mutable counters | 2, 7 | ⬜ |
| Event sourcing vs CRUD — and where we sit | 2 | ⬜ |
| Finite state machines for document lifecycle | 8 | ⬜ |
| Idempotency keys for financial mutations | 9 | ⬜ |
| Optimistic vs pessimistic concurrency control | 7 | ⬜ |
| Layered architecture: controller / service / data | 0 | ◐ |
| Full request lifecycle across all five layers | 0 | ✅ |
| Immutability & reversing entries over mutation | 2 | ⬜ |
| Derived state vs stored state (trade-offs) | 2–3 | ⬜ |
| FIFO / weighted-average-cost valuation algorithms | 7 | ⬜ |
| 3-way matching (PO / receipt / invoice) | 8 | ⬜ |
| Recursive tree resolution & cycle detection (BOM) | 10 | ⬜ |
| Caching strategies & invalidation | 5+ | ⬜ |
| API versioning & backward compatibility | 0 | ⬜ |

### Security & auth

| Topic | Phase | Status |
|---|---|---|
| JWT: structure, signing, what it can't do | 1 | ⬜ |
| Access + refresh token rotation, replay detection | 1 | ⬜ |
| httpOnly / Secure / SameSite cookies vs `localStorage` | 1 | ◐ |
| CSRF: mechanism and mitigation | 1 | ◐ |
| bcrypt: salts, cost factor, timing attacks | 1 | ⬜ |
| RBAC vs ABAC modelling | 1 | ⬜ |
| SQL injection & why parameterisation works | 1 | ⬜ |
| OWASP Top 10 mapped to this codebase | later | ⬜ |
| Presigned uploads: threat model | 14 | ⬜ |

### Testing & tooling

| Topic | Phase | Status |
|---|---|---|
| Unit vs integration vs e2e — what each proves | 1 | ⬜ |
| Mocking a DB pool, and why it proves less than you think | 1 | ⬜ |
| Testing transactions and rollback paths | 2 | ⬜ |
| Testing concurrency (two clients, one row) | 7 | ⬜ |
| Docker layer caching & multi-stage builds | 0 | ⬜ |
| Debugging a blocked event loop in production | later | ⬜ |
