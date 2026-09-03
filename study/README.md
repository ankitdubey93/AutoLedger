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
| [react/react-foundations.md](react/react-foundations.md) | JSX as function calls, reconciliation, Fiber and interruptible rendering, why the hook rules exist, state updates & re-renders, **controlled forms and discriminated-union wizard step state**, context cost, React 19 additions |
| [typescript/typescript-foundations.md](typescript/typescript-foundations.md) | Compiler pipeline, erasure and its exceptions, structural typing, inference & narrowing, `any` vs `unknown`, what `strict` buys, generics, `satisfies`, **declaration merging for `req.user`, and the `\| null` over `?:` rule under `exactOptionalPropertyTypes`** |
| [postgresql/postgresql-foundations.md](postgresql/postgresql-foundations.md) | Process-per-connection, heap/TOAST storage, WAL and crash recovery, MVCC, the query pipeline, all six index types, extensibility, **the extended query protocol — the actual mechanism behind parameterisation, and what it can't protect** |

### Node & Express

| Note | Covers |
|---|---|
| [event-loop-and-blocking.md](node-express/event-loop-and-blocking.md) | Loop phases, microtask queues, `nextTick` vs `setImmediate`, libuv thread pool, why network I/O doesn't use it, `bcryptjs` blocking the main thread |
| [express-middleware-and-async-errors.md](node-express/express-middleware-and-async-errors.md) | Router layer stack, `next()` closure, arity-based error-middleware detection, the Express 4 async-throw trap and how Express 5 closes it, path-to-regexp v8 breakage, middleware ordering |
| [graceful-shutdown-and-process-lifecycle.md](node-express/graceful-shutdown-and-process-lifecycle.md) | Signal dispositions and exit code 143, `server.close()` vs `closeIdleConnections()`, drain ordering, unref'd watchdog timers, PID 1, why npm swallows signals |

### TypeScript

| Note | Covers |
|---|---|
| [branded-types-for-money.md](typescript/branded-types-for-money.md) | IEEE 754 and why floats can't hold money, integer cents, `BIGINT` vs `NUMERIC`, structural vs nominal typing, branding with `unique symbol`, branded IDs for tenant safety |
| [const-assertions-and-satisfies.md](typescript/const-assertions-and-satisfies.md) | Type widening, `as const` freezing to literals, deriving a union with `(typeof X)[number]`, `satisfies` as a non-widening check, why not `zod` for a static list, `isAppSlug` as the required runtime predicate |
| [runtime-validation-and-zod.md](typescript/runtime-validation-and-zod.md) | **Type erasure at the boundary, parse-don't-validate, `z.infer` unifying schema and type, `.refine` for cross-field rules, why the hand-rolled validators stayed for auth, the `exactOptionalPropertyTypes` collision** |

### PostgreSQL

| Note | Covers |
|---|---|
| [transactions-isolation-pooling.md](postgresql/transactions-isolation-pooling.md) | Session-per-connection, why `pool.query` escapes a transaction, MVCC, all four isolation levels, lost update, `FOR UPDATE`, deadlocks, `BIGINT`-as-string, **aborted-transaction state, `ON CONFLICT DO NOTHING` vs `SAVEPOINT`, `DELETE … RETURNING` as an atomic claim** |
| [migrations-and-schema-evolution.md](postgresql/migrations-and-schema-evolution.md) | Transactional DDL and why MySQL can't, what actually proves idempotency, where `IF NOT EXISTS` doesn't exist, checksums as edit-detection, session vs transaction advisory locks, expand/contract, `ALTER TABLE` lock levels, `CREATE INDEX CONCURRENTLY` |
| [deferred-constraint-triggers.md](postgresql/deferred-constraint-triggers.md) | **Why a CHECK can't span rows, the four trigger timings, `DEFERRABLE INITIALLY DEFERRED` firing at COMMIT, the unassigned-`NEW`-on-DELETE trap, the zero-line hole, testing a DB guarantee by bypassing the service** |
| [recursive-ctes-and-hierarchies.md](postgresql/recursive-ctes-and-hierarchies.md) | `WITH RECURSIVE` as fixed-point iteration over a working table, `UNION` vs `UNION ALL` on cyclic data, cycle detection with a path array, scoping every term, adjacency list vs closure table vs nested set vs `ltree`, **and walking a tree downward for a subtree rollup — the `(id, id)` self-pair anchor, transitive closure, and why the read side can skip its own cycle guard given a write-side guarantee** |
| [aggregating-a-ledger.md](postgresql/aggregating-a-ledger.md) | `FILTER` vs `CASE` inside an aggregate, one scan vs N round trips, `generate_series` as a gap-filling scaffold, why a `LEFT JOIN`'s scope predicate must sit in `ON` not `WHERE`, why no summary table, **composing one shared filter predicate for a count query and its page query, `EXISTS` vs `JOIN`+`DISTINCT`, parameterized `ILIKE` wildcards, and why `LIMIT/OFFSET` needs a unique `ORDER BY` tiebreaker** |
| [composite-foreign-keys-for-tenancy.md](postgresql/composite-foreign-keys-for-tenancy.md) | Composite FKs enforcing "same tenant" at the schema level, the required composite `UNIQUE` target, `MATCH SIMPLE` vs `MATCH FULL`, the `ON DELETE SET NULL` trap on a composite key |
| [window-functions-and-running-totals.md](postgresql/window-functions-and-running-totals.md) | **`OVER (ORDER BY ...)` in SQL's logical order of operations and why that lets a running balance survive pagination, `ROWS` vs the default `RANGE` frame and the tied-peer-rows bug, why the frame still needs a unique `ORDER BY` tiebreaker, rejected: app-code accumulation, a correlated subquery per row, a stored running-balance column** |

### Architecture

| Note | Covers |
|---|---|
| [multi-tenancy-row-level-scoping.md](architecture/multi-tenancy-row-level-scoping.md) | Row-level vs schema-per-tenant vs database-per-tenant, Postgres RLS as a backstop, why `user_id` was the wrong boundary, **RBAC vs ABAC vs ReBAC**, the 15-minute revocation window, and the 7 concrete cross-tenant isolation tests |
| [stack-overview-request-lifecycle.md](architecture/stack-overview-request-lifecycle.md) | End-to-end request trace; the layering rule and how to test that the boundary is real (also listed under Foundations) |
| [api-versioning.md](architecture/api-versioning.md) | How Express rewrites `req.url`/`baseUrl` on mount, path vs header vs media-type versioning, what actually counts as a breaking change, Express 5 path syntax |
| [modular-monolith-app-namespacing.md](architecture/modular-monolith-app-namespacing.md) | One deploy vs many, why the app slug is a routing convention and not a security boundary, table-naming as the data-layer half of the same convention, monorepo/microservices rejected and why, the app↔GL integration point |
| [double-entry-as-an-invariant.md](architecture/double-entry-as-an-invariant.md) | **Double-entry as a checksum on financial data, append-only ledgers vs mutable counters and the lost-update class they eliminate, reversing entries over mutation, derived vs stored state, where this sits relative to event sourcing** |

### Tooling

| Note | Covers |
|---|---|
| [typescript-build-and-dev-tooling.md](tooling/typescript-build-and-dev-tooling.md) | Erasure and why transpiling ≠ type-checking, `tsx`/esbuild, TypeScript 7's Go binary, `NodeNext` vs `bundler` resolution and the `.js` extension rule, `verbatimModuleSyntax`, what `strict` omits, Vite's two pipelines and Rolldown, build-time env inlining |
| [testing-with-vitest.md](tooling/testing-with-vitest.md) | Why Vitest over Jest (ESM mocking, the `require`-registry problem, verified Jest 30 failures), forks vs threads isolation, **how to write a test** — AAA, `it.each`, error paths, test doubles, supertest, real-DB integration, coverage as a negative signal, the `vi.mock` hoisting trap |

### React

| Note | Covers |
|---|---|
| [context-effects-and-data-fetching.md](react/context-effects-and-data-fetching.md) | The three-state session union and why it fixes the login flash, StrictMode double-invoke, `AbortController` vs the `ignore` flag (and the CORS-preflight interaction that forced the switch), splitting a context to control re-renders, cache invalidation on org switch via remount keys, React 19 additions |
| [routing-nested-and-dynamic-segments.md](react/routing-nested-and-dynamic-segments.md) | Nested routes as a tree not a lookup table, layout routes and `<Outlet/>`, dynamic segments vs splats, `useParams` typing gap, `<Navigate>` vs `navigate()`, gating a route on fetched data rather than only auth state, the remount-by-`key` cache-invalidation trick, relative-path resolution (pathname vs pathnameBase) and why the sidebar used absolute app-scoped paths, why removing chrome from a subtree is a routing change (making a route a sibling, not a child) rather than a conditional render, what an ancestor's behavior loses when a route moves out from under it, `useSearchParams` as URL-backed, linkable filter state, **and the list/create/detail sibling-route split, static-beats-dynamic specificity scoring, and why a dynamic segment isn't itself what makes relative links fragile** |
| [utility-first-css-tailwind.md](react/utility-first-css-tailwind.md) | How Tailwind scans for literals (and why dynamic class names emit nothing), v4's CSS-first `@theme` config, cascade layers and why unlayered CSS beat Preflight, the honest trade utilities make, **why no Tailwind utility can ever override an unlayered rule and the scoped-unlayered-rule fix, and retiring a `:has()` selector once the component boundary it detected became an explicit routing fact instead** |

### Security & Auth

| Note | Covers |
|---|---|
| [jwt-and-refresh-rotation.md](security-auth/jwt-and-refresh-rotation.md) | base64url anatomy, HMAC-SHA256, signed ≠ encrypted, why a JWT can't be revoked, the access/refresh split, `DELETE … RETURNING` as an atomic claim, reuse detection + family invalidation and its two-tab race, why `jti` is mandatory, why one shared secret is a vulnerability |
| [password-hashing-and-timing.md](security-auth/password-hashing-and-timing.md) | Why not SHA-256, salts, work factors, the `$2b$` format, **the 72-byte truncation**, timing oracles and dummy-hash comparison, native bcrypt on the libuv threadpool vs `bcryptjs`, scrypt/Argon2 |
| [cookies-samesite-and-csrf.md](security-auth/cookies-samesite-and-csrf.md) | Origin vs site, why `:5173`→`:5000` is same-site, the `127.0.0.1` trap, the three SameSite values, the Lax navigation hole that made refresh a POST, httpOnly vs `localStorage`, the `clearCookie` attribute-matching trap, CSRF mechanics |

---

## Coverage tracker

What's owed as the build progresses. The gap is recorded here rather than as a placeholder file.

**✅** covered by a dedicated note · **◐** covered at foundations level only, deep-dive still owed when the phase lands · **⬜** not covered.

**Phase numbers were renumbered in Phase 2**, when AutoLedger became a suite of seven apps and the module-based roadmap (Inventory, Procurement, MRP, Payroll, QMS, CRM, EAM) was dropped — see [roadmap.md](../docs/roadmap.md#dropped-from-scope). A topic whose only owning phase was one of the dropped modules is marked **dropped** below rather than left pointing at a phase number that no longer exists; it stays in the tracker as a record of what was covered by the old plan.

**Renumbered again on 2026-09-01**, when LedgerCore and AP-Flow were specified in full: LedgerCore took Phases 3–4, 6, 8–9 and AP-Flow 10–11, shifting everything downstream. The Phase column below is updated to the new numbers; the mapping is in [roadmap.md](../docs/roadmap.md#phase-renumbering--2026-09-01).

That restructure also **un-dropped four topics**. `WITH RECURSIVE` returns as LedgerCore's chart-of-accounts hierarchy, `EXCLUDE USING GIST` as non-overlapping fiscal periods, `JSONB` as audit snapshots and extraction payloads, and fuzzy string matching as bank reconciliation. They were marked dropped when the modules that needed them were cut; different apps need the same techniques, which is a useful thing to have noticed. See [roadmap.md](../docs/roadmap.md) for the current phase table.

### Node & Express

| Topic | Phase | Status |
|---|---|---|
| Event loop, microtasks, thread pool | 0–1 | ✅ |
| Middleware chain, async error handling | 0–1 | ✅ |
| Streams & backpressure | 10 (AP-Flow document uploads), 15 (BoardDeck `.pptx`) | ◐ |
| `worker_threads` vs child processes vs queue consumers | 7 | ◐ |
| Graceful shutdown, connection draining, `SIGTERM` | 0 | ✅ |
| `AsyncLocalStorage` for request context | 5 (audit actor) | ⬜ |
| BullMQ: queues, workers, retries, DLQ, idempotent jobs | 7 | ⬜ |
| Cron scheduling & idempotent batch jobs | 15 (BoardDeck close automation) | ⬜ |
| Multipart uploads: MIME sniffing, size caps, path traversal | 10 (AP-Flow) | ⬜ |
| Rate limiting: fixed vs sliding window, per-IP vs per-account | 3 | ◐ |

### TypeScript

| Topic | Phase | Status |
|---|---|---|
| Branded types, structural vs nominal typing | 3 | ✅ |
| Declaration merging (`req.user`) | 1 | ✅ |
| Discriminated unions for FSM state | 10 (AP-Flow document status) | ◐ |
| Runtime validation at the boundary: parse, don't validate | 3 (zod, nested `lines[]`) | ✅ |
| Generics & constrained type parameters | 3 | ✅ |
| `unknown` vs `any`, type guards, narrowing | 1 | ✅ |
| Utility types (`Pick`, `Omit`, `Partial`, `Record`) | 3 | ◐ |
| Conditional & mapped types | later | ⬜ |
| `satisfies`, `as const`, deriving a union from data | 2 | ✅ |
| `strict` mode: what each flag actually buys | 0 | ✅ |

### PostgreSQL

| Topic | Phase | Status |
|---|---|---|
| Transactions, isolation, pooling | 1, 3 | ✅ |
| Index types: B-tree, GIN, GiST, partial, covering | 3+ | ✅ |
| `EXPLAIN ANALYZE` and reading a query plan | 3+ | ◐ |
| Constraints: CHECK, UNIQUE, EXCLUDE, deferrable | 1, 3 | ✅ |
| **Deferred constraint triggers: enforcing a multi-row invariant at `COMMIT`** | 3 (balance check) | ✅ |
| Triggers & `updated_at`; CDC audit snapshots | 5 | ⬜ |
| Passing request context to a trigger (`SET LOCAL` + `current_setting`) | 5 (audit actor + IP) | ⬜ |
| `WITH RECURSIVE` CTEs + cycle detection | 3 (chart-of-accounts hierarchy), 3.6 (subtree balance rollups) | ✅ |
| Aggregate `FILTER` clauses, `generate_series` gap-filling | 3.5 (LedgerCore dashboard) | ✅ |
| Composite foreign keys for cross-table tenancy checks | 3.5 (LedgerCore settings) | ✅ |
| Window functions (running balances, ledger reports) | 3.6 (LedgerCore account ledger) | ✅ |
| `EXCLUDE USING GIST` + `btree_gist` for date ranges | 4 (non-overlapping fiscal periods) | ⬜ |
| `JSONB`: operators, indexing, when *not* to use it | 5 (audit snapshots), 6 (score breakdown), 10 (extractions) | ◐ |
| `pg_trgm` fuzzy search | dropped (was CRM) — Phase 6 scores in TypeScript instead | ⬜ |
| `pgvector`: similarity search, index types (IVFFlat/HNSW) | 16 (TaxGuard AI) | ⬜ |
| Partitioning strategies | later | ⬜ |
| Migration design: additive, idempotent, zero-downtime | 0–1 | ✅ |

### React

| Topic | Phase | Status |
|---|---|---|
| Reconciliation, keys, render triggers | 1 | ✅ |
| Hook rules and why they exist (the call-order model) | 1 | ✅ |
| `useEffect` dependency array, cleanup, double-invoke in StrictMode | 1 | ✅ |
| Context: composition, re-render cost, splitting providers | 1 | ✅ |
| Nested routes, layout routes, dynamic segments | 2 | ✅ |
| `useMemo` / `useCallback` / `React.memo` — when they actually help | 3+ | ◐ |
| Data fetching, races, cancellation, cache invalidation on org switch | 1–2 | ✅ |
| Controlled vs uncontrolled forms, discriminated-union wizard step state | 3 (multi-line journal entry), 3.5 (onboarding wizard) | ✅ |
| Utility-first CSS; Tailwind v4's CSS-first config | 3 | ✅ |
| React 19 specifics (`use`, Actions, compiler) | 1 | ✅ |
| Error boundaries & suspense | 3+ | ◐ |

### Architecture & patterns

| Topic | Phase | Status |
|---|---|---|
| Multi-tenancy isolation strategies | 1 | ✅ |
| Modular monolith: app boundaries without a network boundary | 2 | ✅ |
| Double-entry bookkeeping as an invariant system | 3 | ✅ |
| Append-only ledgers vs mutable counters | 3 | ✅ |
| Event sourcing vs CRUD — and where we sit | 3 | ✅ |
| Finite state machines for document lifecycle | 10 (AP-Flow) | ⬜ |
| Idempotency keys for financial mutations | 9+ | ⬜ |
| **Enforcing an invariant in the DB vs the application — and why both** | 3 | ✅ |
| Edit distance (Levenshtein DP) & confidence scoring | 6 (bank reconciliation) | ⬜ |
| Human-in-the-loop review: thresholds, explainable scores | 6, 11 | ⬜ |
| Content-addressed storage & hash-based provenance | 10 (AP-Flow) | ⬜ |
| Multimodal extraction: structured output, per-field confidence | 10 (AP-Flow) | ⬜ |
| Optimistic vs pessimistic concurrency control | dropped (was Inventory `FOR UPDATE`) | ⬜ |
| Layered architecture: controller / service / data | 0 | ✅ |
| Full request lifecycle across all five layers | 0 | ✅ |
| Immutability & reversing entries over mutation | 3 | ✅ |
| Derived state vs stored state (trade-offs) | 3–4 | ✅ |
| FIFO / weighted-average-cost valuation algorithms | dropped (was Inventory) | ⬜ |
| 3-way matching (PO / receipt / invoice) | 11 (AP-Flow) | ⬜ |
| Recursive tree resolution & cycle detection | 3 (chart of accounts; was MRP/BOM) | ✅ |
| RAG: chunking, embeddings, retrieval, citation grounding | 16 (TaxGuard AI) | ⬜ |
| PII redaction before an external model call | 10 (AP-Flow images), 16 (TaxGuard text) | ⬜ |
| Caching strategies & invalidation | 7+ | ⬜ |
| API versioning & backward compatibility | 0 | ✅ |

### Security & auth

| Topic | Phase | Status |
|---|---|---|
| JWT: structure, signing, what it can't do | 1 | ✅ |
| Access + refresh token rotation, replay detection | 1 | ✅ |
| httpOnly / Secure / SameSite cookies vs `localStorage` | 1 | ✅ |
| CSRF: mechanism and mitigation | 1 | ✅ |
| bcrypt: salts, cost factor, timing attacks | 1 | ✅ |
| RBAC vs ABAC modelling | 1 | ✅ |
| SQL injection & why parameterisation works | 1 | ✅ |
| OWASP Top 10 mapped to this codebase | later | ⬜ |
| File upload threat model: MIME spoofing, path traversal, zip bombs | 10 (AP-Flow document capture) | ⬜ |
| Data minimisation: what you send a third party, and proving it | 10 (PII pixel masking) | ⬜ |

### Testing & tooling

| Topic | Phase | Status |
|---|---|---|
| Transpiling vs type-checking; `tsx`, `tsc`, Vite, module resolution | 0 | ✅ |
| Test runner choice: Vitest vs Jest, ESM mocking, isolation pools | 0 | ✅ |
| Writing tests: AAA, table-driven, error paths, doubles, supertest | 0 | ✅ |
| Unit vs integration vs e2e — what each proves | 1 | ✅ |
| Mocking a DB pool, and why it proves less than you think | 1 | ✅ |
| Testing transactions and rollback paths | 3 | ✅ |
| Testing concurrency (two clients, one row) | dropped (was Inventory `FOR UPDATE`) | ⬜ |
| Docker layer caching & multi-stage builds | deployment | ⬜ |
| Debugging a blocked event loop in production | later | ⬜ |

Phase 0 built no Dockerfiles — Postgres and Redis run in containers, the app runs on the host ([development.md](../docs/development.md#why-not-full-docker)). The multi-stage build note is owed when a production image is actually built.
