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
| [graceful-shutdown-and-process-lifecycle.md](node-express/graceful-shutdown-and-process-lifecycle.md) | Signal dispositions and exit code 143, `server.close()` vs `closeIdleConnections()`, drain ordering, unref'd watchdog timers, PID 1, why npm swallows signals, **and the worker process's own drain — waiting out an in-flight job rather than a request, and what BullMQ's lock-expiry reclaim does for a job whose process is SIGKILLed** |
| [async-local-storage-request-context.md](node-express/async-local-storage-request-context.md) | **`AsyncLocalStorage` as implicit per-request state across `await` boundaries via Node's async resource graph, why concurrent requests don't collide, why the context object has to be mutable given middleware ordering, and what a background job loses when it crosses a process boundary** |
| [parsing-untrusted-csv.md](node-express/parsing-untrusted-csv.md) | **A hand-written two-pass CSV state machine — why `split(',')` can't handle quoted commas or embedded newlines, quote-escaping and the `fieldStarted` guard, delimiter sniffing outside quotes only, BOM stripping, and row-length validation (pad short, reject long) instead of silent truncation** |
| [image-processing-and-rasterization.md](node-express/image-processing-and-rasterization.md) | **`sharp`/libvips' demand-driven striped pipeline vs a pure-JS decode/transform/encode model, EXIF orientation and `.rotate()`, pixel compositing with a `create` input over an SVG overlay, `pdfjs-dist`'s injectable Node canvas factory and why `@napi-rs/canvas` is a transitive optionalDependency never imported directly, the points-to-pixels `DPI / 72` viewport scale, and verifying a library's API against its own installed `.d.ts` rather than memory of an older major version** |

### TypeScript

| Note | Covers |
|---|---|
| [branded-types-for-money.md](typescript/branded-types-for-money.md) | IEEE 754 and why floats can't hold money, integer cents, `BIGINT` vs `NUMERIC`, structural vs nominal typing, branding with `unique symbol`, branded IDs for tenant safety, **scaling money by a rational factor (`scaleCents`) without overflowing native `number` arithmetic — why `BigInt`, half-up rounding, and per-line vs pre-summed tax rounding — parsing money from untrusted bank-CSV text (`parseMoneyText`) with no intermediate float: asymmetric dot/comma separator resolution, accounting parentheses and CR/DR notation, and why a third decimal digit is a rejection, not a rounding — and why an exchange rate is deliberately *not* branded the way `Cents` is: a `string` end to end with one chokepoint function, not a tagged `number`** |
| [const-assertions-and-satisfies.md](typescript/const-assertions-and-satisfies.md) | Type widening, `as const` freezing to literals, deriving a union with `(typeof X)[number]`, `satisfies` as a non-widening check, why not `zod` for a static list, `isAppSlug` as the required runtime predicate |
| [runtime-validation-and-zod.md](typescript/runtime-validation-and-zod.md) | **Type erasure at the boundary, parse-don't-validate, `z.infer` unifying schema and type, `.refine` for cross-field rules, why the hand-rolled validators stayed for auth, the `exactOptionalPropertyTypes` collision, and "parse, don't validate" applied to a value that's deliberately kept opaque — the onboarding wizard's untrusted `Record<string, unknown>` JSONB draft, never spread into a query, re-parsed through the real schema only at completion** |

### PostgreSQL

| Note | Covers |
|---|---|
| [transactions-isolation-pooling.md](postgresql/transactions-isolation-pooling.md) | Session-per-connection, why `pool.query` escapes a transaction, MVCC, all four isolation levels, lost update, `FOR UPDATE`, deadlocks, `BIGINT`-as-string, **aborted-transaction state, `ON CONFLICT DO NOTHING` vs `SAVEPOINT`, `DELETE … RETURNING` as an atomic claim, and `FOR UPDATE SKIP LOCKED` as a batch queue-claim primitive — contrasted with `DELETE … RETURNING`'s one-shot consume-and-return shape** |
| [migrations-and-schema-evolution.md](postgresql/migrations-and-schema-evolution.md) | Transactional DDL and why MySQL can't, what actually proves idempotency, where `IF NOT EXISTS` doesn't exist, checksums as edit-detection, session vs transaction advisory locks, expand/contract, `ALTER TABLE` lock levels, `CREATE INDEX CONCURRENTLY` |
| [deferred-constraint-triggers.md](postgresql/deferred-constraint-triggers.md) | **Why a CHECK can't span rows, the four trigger timings, `DEFERRABLE INITIALLY DEFERRED` firing at COMMIT, the unassigned-`NEW`-on-DELETE trap, the zero-line hole, testing a DB guarantee by bypassing the service, partial immutability via a `to_jsonb` row-diff for one allowed transition, same-timing trigger firing order (alphabetical by name), and a deferred-trigger pair — parent-completeness plus a cross-table, cross-transaction no-overallocation check that needs a row lock, not just deferral, to be race-free** |
| [gapless-numbering-and-counters.md](postgresql/gapless-numbering-and-counters.md) | **Why a `SEQUENCE` and `MAX(n)+1` both fail for a human-facing document number, a counter row locked by a plain `UPDATE`'s implicit row lock, allocating inside the document's own transaction so a rollback un-burns the number, `ON CONFLICT DO NOTHING` as a lazy row seed, and what "gapless" actually means for an auditor** |
| [recursive-ctes-and-hierarchies.md](postgresql/recursive-ctes-and-hierarchies.md) | `WITH RECURSIVE` as fixed-point iteration over a working table, `UNION` vs `UNION ALL` on cyclic data, cycle detection with a path array, scoping every term, adjacency list vs closure table vs nested set vs `ltree`, **and walking a tree downward for a subtree rollup — the `(id, id)` self-pair anchor, transitive closure, and why the read side can skip its own cycle guard given a write-side guarantee** |
| [aggregating-a-ledger.md](postgresql/aggregating-a-ledger.md) | `FILTER` vs `CASE` inside an aggregate, one scan vs N round trips, `generate_series` as a gap-filling scaffold, why a `LEFT JOIN`'s scope predicate must sit in `ON` not `WHERE`, why no summary table, composing one shared filter predicate for a count query and its page query, `EXISTS` vs `JOIN`+`DISTINCT`, parameterized `ILIKE` wildcards, why `LIMIT/OFFSET` needs a unique `ORDER BY` tiebreaker, a correlated scalar subquery vs `JOIN`+`GROUP BY` when the outer query must stay 1:1, `FILTER` aggregates over a `UNION ALL` of two unrelated tables, deriving a P&L/balance sheet from raw lines — the type-aware sign flip, `INNER JOIN` vs the trial balance's `LEFT JOIN`, splitting one scan into a prior/current-year `FILTER` pair, and retained earnings computed rather than posted by a closing entry, **and the same shared-builder + `EXISTS` discipline reused for a bank-line register's `minScore` filter, correlated against a different table entirely** |
| [composite-foreign-keys-for-tenancy.md](postgresql/composite-foreign-keys-for-tenancy.md) | Composite FKs enforcing "same tenant" at the schema level, the required composite `UNIQUE` target, `MATCH SIMPLE` vs `MATCH FULL`, the `ON DELETE SET NULL` trap on a composite key |
| [window-functions-and-running-totals.md](postgresql/window-functions-and-running-totals.md) | **`OVER (ORDER BY ...)` in SQL's logical order of operations and why that lets a running balance survive pagination, `ROWS` vs the default `RANGE` frame and the tied-peer-rows bug, why the frame still needs a unique `ORDER BY` tiebreaker, rejected: app-code accumulation, a correlated subquery per row, a stored running-balance column** |
| [subledger-reconciliation-and-aging.md](postgresql/subledger-reconciliation-and-aging.md) | **Date-bucketing with a parameterized `CASE` ladder vs `age()`/`width_bucket()`, gap-filling a fixed bucket enum with a `VALUES`-list `LEFT JOIN`, reconciling a subledger total against its GL control account as an integer-equality assertion — why the two are computed independently and what a mismatch actually means — and the same pattern applied to bank reconciliation, where a `false` result is a completeness claim about an external statement import, not a correctness claim about the books** |
| [exclusion-constraints-and-gist.md](postgresql/exclusion-constraints-and-gist.md) | **`EXCLUDE` as `UNIQUE` generalized to any operator, why GIST (not B-tree) supports range-overlap `&&`, `btree_gist` for mixing scalar equality into a GIST index, `daterange` bounds-inclusivity (`'[]'` vs `'[)'`), the `23P01` exclusion-violation code, and why this closes a check-then-write race a service-level pre-check cannot** |
| [audit-triggers-and-session-variables.md](postgresql/audit-triggers-and-session-variables.md) | **`to_jsonb(NEW)`/`to_jsonb(OLD)` generic row snapshots, deriving a changed-key diff with `jsonb_each` + `IS DISTINCT FROM`, `TG_ARGV` for parameterizing one trigger function across many tables, `set_config(..., is_local := true)` vs `SET LOCAL` and why only the function form is parameterizable, and why this trigger must be `AFTER` where the period-lock guard is `BEFORE`** |
| [integrity-checking-a-ledger.md](postgresql/integrity-checking-a-ledger.md) | **`HAVING` vs `WHERE` for filtering on an aggregate, `LEFT JOIN`/`IS NULL` anti-joins vs the `NOT IN` NULL trap, exact `BigInt` equality over any epsilon, and the one file in this codebase deliberately exempted from tenant scoping — with the reasoning written down** |
| [idempotent-ingestion-and-dedupe-hashes.md](postgresql/idempotent-ingestion-and-dedupe-hashes.md) | **Content-addressed SHA-256 dedupe hashing scoped per tenant, `UNIQUE (org_id, dedupe_hash)`, `INSERT ... ON CONFLICT DO NOTHING RETURNING id` as an atomic dedupe-and-count in one round trip, why a natural key `(date, amount, description)` collides on real bank data, and the occurrence-ordinal fix for two genuinely identical rows within one file** |
| [multi-currency-and-functional-currency.md](postgresql/multi-currency-and-functional-currency.md) | **Redefining a balance invariant (`CREATE OR REPLACE FUNCTION`) without editing the applied migration that created it, why "balanced" can only mean equal sums in one functional currency once an entry mixes currencies, a conditional native-currency check layered under an unconditional base-currency one, a single-row CHECK proving `base = round(native × rate)` with zero backfill, and why Postgres `round()` and the service's `scaleCents` are provably the same rounding rule for every value that can reach them** |
| [partial-unique-indexes.md](postgresql/partial-unique-indexes.md) | **A unique index scoped by a `WHERE` predicate evaluated at write time — why it closes a check-then-act race a service-level `SELECT` can't, `CHECK` vs unique index vs `EXCLUDE` as the three table-level-invariant tools and which one fits which shape, `NULL`-never-equals-`NULL` in a unique index, why a partial index only serves a query whose `WHERE` implies its predicate, and mapping a `23505` on a specific constraint name (never message-text matching) to `409`** |

### Architecture

| Note | Covers |
|---|---|
| [multi-tenancy-row-level-scoping.md](architecture/multi-tenancy-row-level-scoping.md) | Row-level vs schema-per-tenant vs database-per-tenant, Postgres RLS as a backstop, why `user_id` was the wrong boundary, **RBAC vs ABAC vs ReBAC**, the 15-minute revocation window, and the 7 concrete cross-tenant isolation tests |
| [stack-overview-request-lifecycle.md](architecture/stack-overview-request-lifecycle.md) | End-to-end request trace; the layering rule and how to test that the boundary is real (also listed under Foundations) |
| [api-versioning.md](architecture/api-versioning.md) | How Express rewrites `req.url`/`baseUrl` on mount, path vs header vs media-type versioning, what actually counts as a breaking change, Express 5 path syntax |
| [modular-monolith-app-namespacing.md](architecture/modular-monolith-app-namespacing.md) | One deploy vs many, why the app slug is a routing convention and not a security boundary, table-naming as the data-layer half of the same convention, monorepo/microservices rejected and why, the app↔GL integration point |
| [double-entry-as-an-invariant.md](architecture/double-entry-as-an-invariant.md) | **Double-entry as a checksum on financial data, append-only ledgers vs mutable counters and the lost-update class they eliminate, reversing entries over mutation, derived vs stored state, where this sits relative to event sourcing** |
| [document-lifecycle-fsm.md](architecture/document-lifecycle-fsm.md) | **One transition table (`as const satisfies Record<Status, ...>`) mirrored by a `status` CHECK constraint, why scattered `if (status === 'X')` checks rot, draft-mutable vs posted-immutable states, correction as reversal not edit, a `to_jsonb` row-diff trigger for a single allowed post-issue transition, a four-state FSM with a backward recall edge (`AWAITING_APPROVAL -> DRAFT`) plus role-gated approval as a segregation-of-duties control independent of the FSM itself, a genuinely terminal state (`LOCKED`) with no outbound edge at all — why it differs from `VOID`'s empty edge list, and why locking must pass through `CLOSED` first — a reversible state (`MATCHED -> UNMATCHED`) whose reverse edge carries a GL side effect (voiding a payment), plus why one endpoint layers an extra check on top of the shared table rather than trusting it alone, when two different verbs both land on the same target state — a "completed" state deliberately left non-terminal (`COMPLETED -> IN_PROGRESS`) because the label is a promise about the past, not the future, plus the `from === to` self-transition trap a naive table falls into — and a backward edge (`VALIDATED -> DRAFT`) that exists purely so a status can never lie about the data underneath it — **and an FSM with no terminal state anywhere in it, because nothing it guards has posted to the ledger yet: the real test for terminality was never "does this state sound final," it's "does leaving here require undoing a posted financial fact"** |
| [staged-import-and-two-phase-commit.md](architecture/staged-import-and-two-phase-commit.md) | **Stage-everything-then-validate vs abort-on-first-error, contrasted directly against this codebase's own two importers; when each shape is right (untrusted-but-structured human export vs machine-generated feed); re-validating an entire batch after one row's fix so the status can never drift from the data; why commit stays all-or-nothing even though staging deliberately wasn't; and the general principle for choosing between the two shapes** |
| [derived-vs-stored-state.md](architecture/derived-vs-stored-state.md) | **Why settlement (how much of an invoice/bill is paid) is a correlated-subquery read, never a stored column — voiding a payment un-settles for free because immutable allocation rows simply stop counting; the precedence rules in `settlementStatusOf`; reconciling a derived subledger total against the GL as a cross-check, not just a display value; and the one deliberate stored-not-derived exception in this codebase, `payment_allocations.base_amount_cents` — why a value derived from two independently-frozen facts still needs to be pinned at write time to stay permanently tied to the GL** |
| [append-only-audit-trails.md](architecture/append-only-audit-trails.md) | **CDC vs application-level activity logs, why the audit table is the one place FKs are deliberately omitted, an integer identity key over a UUID for arrival-order, `txid` as the grouping key for one multi-table transaction, and what "immutable" honestly does and doesn't prove against a privileged actor** |
| [fuzzy-matching-and-confidence-scoring.md](architecture/fuzzy-matching-and-confidence-scoring.md) | **Hand-written Levenshtein distance and the rolling-array space reduction from O(m×n) to O(min(m,n)), text normalization before comparison, weighted independent multi-signal scoring (amount/date/counterparty) for explainability over one blended similarity number, the noise floor that keeps coincidental string overlap from reading as a real signal, storing the score breakdown rather than recomputing it, and the false-positive/false-negative cost asymmetry behind a high auto-match threshold** |
| [background-jobs-and-queues.md](architecture/background-jobs-and-queues.md) | **BullMQ on Redis — lists/sorted-sets and the atomic Lua-scripted state transitions, why a worker needs `maxRetriesPerRequest: null`, retry/exponential-backoff, the dead-letter queue as the actual alerting mechanism (`removeOnFail` alone isn't one), `upsertJobScheduler`'s idempotent repeatable jobs vs the deprecated `add({ repeat })`, why the worker is a separate OS process rather than a `worker_threads` thread, and at-least-once delivery as the reason every handler must be idempotent — plus a purely event-driven, non-repeatable queue with no scheduler entry, the same `jobId` dedup primitive used deliberately in opposite directions (deterministic to prevent a double-registration fan-out, timestamp-suffixed so a re-extraction isn't dropped as a duplicate), and why one enqueue sits outside its own transaction — accepting the dual-write gap the transactional outbox exists to close — because nothing financial is at stake if it's hit** |
| [transactional-outbox.md](architecture/transactional-outbox.md) | **The dual-write problem stated precisely, writing an event row on the caller's own transaction client as the fix, `FOR UPDATE SKIP LOCKED` as the drain's work-claiming primitive, `ON CONFLICT DO NOTHING` fan-out idempotency, the stale-PENDING re-enqueue sweep as what "at-least-once" actually costs, and why exactly-once delivery across a network boundary isn't achievable** |
| [realized-and-unrealized-fx.md](architecture/realized-and-unrealized-fx.md) | **Realized FX gain/loss as one subtraction (`Σ base debits − Σ base credits`) with no direction-specific sign branch, why a receivable settled high is a gain and the mirror payable case falls out for free, one control line per allocation at that allocation's own document rate (never the payment's settlement rate) so a multi-document payment stays per-line CHECK-valid, unrealized period-end revaluation through a single gain/loss account instead of a pair, and why the automatic next-day reversal is what keeps a later realized settlement comparing against a document's original frozen rate instead of a revalued one** |
| [file-storage-and-streaming.md](architecture/file-storage-and-streaming.md) | **Content-addressed storage and free deduplication, why this vault is org-keyed rather than globally content-addressed — the cross-tenant existence oracle and the unsafe-shared-blob deletion problem it closes — two-level hex fan-out and the directory-entry limits it exists for, the narrow `put`/`get`/`stat` interface as the object-storage swap seam, why the blob is written before the database row and an orphan is tolerated (tied directly to the no-post-COMMIT-work rule), `pipe()`'s backpressure vs buffering the whole file, the mandatory `'error'` listener a bare pipe doesn't give you, and the link table as the rule-16 boundary — an app talking to the platform, never to another app's tables** |
| [document-capture-pipeline.md](architecture/document-capture-pipeline.md) | **A fixed rasterize → OCR → detect → mask → extract ordering as a security property, not just a data flow — why OCR must run locally, dependency injection at every real I/O boundary (`OcrAdapter`, `VisionClient`) as what makes the pipeline hermetically testable, why a job payload carries only identifiers and the handler always re-reads from Postgres, `markProcessing`'s atomic guard as the idempotency answer to at-least-once delivery, and the accepted crash-window gap between a transaction commit and its enqueue call** |
| [llm-structured-extraction.md](architecture/llm-structured-extraction.md) | **Forced tool use over free-form-JSON-parsing or regex-over-prose, the API-enforced `input_schema` as a shape guarantee that is not a value-level trust guarantee, re-parsing a `tool_use` block's `unknown` input through zod as a second parse-don't-validate boundary, money crossing the boundary as decimal strings so a JSON number's float representation never touches a cents value, and per-field confidence as a review-routing signal that is never treated as ground truth** |

### Tooling

| Note | Covers |
|---|---|
| [typescript-build-and-dev-tooling.md](tooling/typescript-build-and-dev-tooling.md) | Erasure and why transpiling ≠ type-checking, `tsx`/esbuild, TypeScript 7's Go binary, `NodeNext` vs `bundler` resolution and the `.js` extension rule, `verbatimModuleSyntax`, what `strict` omits, Vite's two pipelines and Rolldown, build-time env inlining |
| [testing-with-vitest.md](tooling/testing-with-vitest.md) | Why Vitest over Jest (ESM mocking, the `require`-registry problem, verified Jest 30 failures), forks vs threads isolation, **how to write a test** — AAA, `it.each`, error paths, test doubles, supertest, real-DB integration, coverage as a negative signal, the `vi.mock` hoisting trap |

### React

| Note | Covers |
|---|---|
| [context-effects-and-data-fetching.md](react/context-effects-and-data-fetching.md) | The three-state session union and why it fixes the login flash, StrictMode double-invoke, `AbortController` vs the `ignore` flag (and the CORS-preflight interaction that forced the switch), splitting a context to control re-renders, cache invalidation on org switch via remount keys, React 19 additions |
| [routing-nested-and-dynamic-segments.md](react/routing-nested-and-dynamic-segments.md) | Nested routes as a tree not a lookup table, layout routes and `<Outlet/>`, dynamic segments vs splats, `useParams` typing gap, `<Navigate>` vs `navigate()`, gating a route on fetched data rather than only auth state, the remount-by-`key` cache-invalidation trick, relative-path resolution (pathname vs pathnameBase) and why the sidebar used absolute app-scoped paths, why removing chrome from a subtree is a routing change (making a route a sibling, not a child) rather than a conditional render, what an ancestor's behavior loses when a route moves out from under it, `useSearchParams` as URL-backed, linkable filter state, the list/create/detail sibling-route split, static-beats-dynamic specificity scoring, why a dynamic segment isn't itself what makes relative links fragile, a query parameter as a one-shot seed vs a live binding — the `?copyFrom=` pre-fill's effect-plus-latch pattern, why two components must share one `canReverse` rule, and the lossless cents round-trip that seeding relies on — **and hard vs. soft route gates: a blocking `<Navigate>` when the guarded content is unsafe or meaningless without its precondition, vs. rendering the real content behind an advisory banner when the precondition is a choice the user is allowed to defer** |
| [utility-first-css-tailwind.md](react/utility-first-css-tailwind.md) | How Tailwind scans for literals (and why dynamic class names emit nothing), v4's CSS-first `@theme` config, cascade layers and why unlayered CSS beat Preflight, the honest trade utilities make, **why no Tailwind utility can ever override an unlayered rule and the scoped-unlayered-rule fix, and retiring a `:has()` selector once the component boundary it detected became an explicit routing fact instead** |
| [accessible-dialogs-and-focus.md](react/accessible-dialogs-and-focus.md) | **Why `window.confirm` is untestable in jsdom and blocks the event loop, `role="dialog"` + `aria-modal` + `aria-labelledby`, focus-on-mount, Escape and `target === currentTarget` outside-click dismissal, native `<dialog>` vs a fully-controlled component, and disambiguating same-labelled buttons with `within()` in tests** |
| [hand-rolled-svg-charts.md](react/hand-rolled-svg-charts.md) | **`viewBox` and SVG's inverted Y axis, linear scaling without a library (and the `Math.max(1, ...)` divide-by-zero guard), zero-value bars as "gap-filled, never a gap," the `role="img"` + `<title>` + `visually-hidden` shadow-table accessibility baseline, and hover-only interaction that's accessible-safe because the same data exists another way** |

### Security & Auth

| Note | Covers |
|---|---|
| [jwt-and-refresh-rotation.md](security-auth/jwt-and-refresh-rotation.md) | base64url anatomy, HMAC-SHA256, signed ≠ encrypted, why a JWT can't be revoked, the access/refresh split, `DELETE … RETURNING` as an atomic claim, reuse detection + family invalidation and its two-tab race, why `jti` is mandatory, why one shared secret is a vulnerability |
| [password-hashing-and-timing.md](security-auth/password-hashing-and-timing.md) | Why not SHA-256, salts, work factors, the `$2b$` format, **the 72-byte truncation**, timing oracles and dummy-hash comparison, native bcrypt on the libuv threadpool vs `bcryptjs`, scrypt/Argon2 |
| [cookies-samesite-and-csrf.md](security-auth/cookies-samesite-and-csrf.md) | Origin vs site, why `:5173`→`:5000` is same-site, the `127.0.0.1` trap, the three SameSite values, the Lax navigation hole that made refresh a POST, httpOnly vs `localStorage`, the `clearCookie` attribute-matching trap, CSRF mechanics |
| [webhook-signing-and-ssrf.md](security-auth/webhook-signing-and-ssrf.md) | **HMAC-SHA256 over `timestamp.body` and why a shared MAC beats a bearer token, replay protection from folding the timestamp into the signed material, `timingSafeEqual` and the timing side-channel it closes, SSRF as the structural risk of fetching a user-supplied URL, the cloud-metadata-endpoint and private-IPv4-range guard, `redirect: 'manual'` as the second half of the same defense, and the DNS-rebinding gap this write-time check honestly doesn't close** |
| [pii-detection-and-redaction.md](security-auth/pii-detection-and-redaction.md) | **"You cannot regex a JPEG" — the fixed rasterize → OCR → detect → mask ordering PII protection depends on, hand-written Luhn and Verhoeff checksums (with the actual table arithmetic) as the difference between a real card-number match and a coincidental digit run, mapping a detected text span back onto OCR word bounding boxes with outward padding, destructive pixel compositing vs recoverable "redaction" (PDF annotations, CSS overlays, selectable text under a black box), and the honest, stated limit — "redaction pipeline implemented," never "PII cannot leak," because recall has never been measured against a labelled corpus** |
| [file-upload-threat-model.md](security-auth/file-upload-threat-model.md) | **Why a multipart `Content-Type` header is an attacker-controlled claim, magic-byte sniffing vs the client's label, the UTF-8-round-trip carve-out for a format (CSV) with no signature, path traversal through a filename or hash and why a positive allowlist regex beats a post-join `startsWith` check, `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` as the pair that stops stored XSS, CRLF header injection through an unsanitized filename, why the size cap must live in the parser's own streaming limits, and decompression bombs as a stated non-defense here** |

---

## Coverage tracker

What's owed as the build progresses. The gap is recorded here rather than as a placeholder file.

**✅** covered by a dedicated note · **◐** covered at foundations level only, deep-dive still owed when the phase lands · **⬜** not covered.

**Phase numbers were renumbered in Phase 2**, when AutoLedger became a suite of seven apps and the module-based roadmap (Inventory, Procurement, MRP, Payroll, QMS, CRM, EAM) was dropped — see [roadmap.md](../docs/roadmap.md#dropped-from-scope). A topic whose only owning phase was one of the dropped modules is marked **dropped** below rather than left pointing at a phase number that no longer exists; it stays in the tracker as a record of what was covered by the old plan.

**Renumbered again on 2026-09-01**, when LedgerCore and AP-Flow were specified in full: LedgerCore took Phases 3–4, 6, 8–9 and AP-Flow 10–11, shifting everything downstream. The Phase column below is updated to the new numbers; the mapping is in [roadmap.md](../docs/roadmap.md#phase-renumbering--2026-09-01).

**Renumbered a third time on 2026-09-10**, but only at the tail: two platform phases were inserted as **9** (onboarding & data migration) and **9.5** (the Document Vault), QuickBooks sync moved from 9 to **17**, and **Phases 10–16 were left untouched**. Only rows citing Phase 9 needed updating. See [roadmap.md](../docs/roadmap.md#phase-renumbering--2026-09-10).

That restructure also **un-dropped four topics**. `WITH RECURSIVE` returns as LedgerCore's chart-of-accounts hierarchy, `EXCLUDE USING GIST` as non-overlapping fiscal periods, `JSONB` as audit snapshots and extraction payloads, and fuzzy string matching as bank reconciliation. They were marked dropped when the modules that needed them were cut; different apps need the same techniques, which is a useful thing to have noticed. See [roadmap.md](../docs/roadmap.md) for the current phase table.

### Node & Express

| Topic | Phase | Status |
|---|---|---|
| Event loop, microtasks, thread pool | 0–1 | ✅ |
| Middleware chain, async error handling | 0–1 | ✅ |
| Streams & backpressure | 9.5 (Document Vault upload/download), 15 (BoardDeck `.pptx`) | ◐ |
| `worker_threads` vs child processes vs queue consumers | 7 | ✅ |
| Graceful shutdown, connection draining, `SIGTERM` | 0, 7 (worker process) | ✅ |
| `AsyncLocalStorage` for request context | 5 (audit actor) | ✅ |
| BullMQ: queues, workers, retries, DLQ, idempotent jobs | 7, 10 (the first purely event-driven, non-repeatable queue) | ✅ |
| Cron scheduling & idempotent batch jobs | 7 (integrity check), 15 (BoardDeck close automation) | ◐ |
| Multipart uploads: MIME sniffing, size caps, path traversal | 9.5 (Document Vault) | ✅ |
| Native image processing (`sharp`/libvips) & headless PDF rasterization | 10 (AP-Flow capture pipeline) | ✅ |
| Rate limiting: fixed vs sliding window, per-IP vs per-account | 3 | ◐ |
| Hand-written parsing of an untrusted delimited text format (CSV) | 6 (bank statement import) | ✅ |

### TypeScript

| Topic | Phase | Status |
|---|---|---|
| Branded types, structural vs nominal typing | 3 | ✅ |
| Declaration merging (`req.user`) | 1 | ✅ |
| Discriminated unions for FSM state | 3.8 (invoice status), 10 (AP-Flow document status) | ✅ |
| Runtime validation at the boundary: parse, don't validate | 3 (zod, nested `lines[]`), 9a (parse-don't-validate applied to a deliberately opaque `Record<string, unknown>` draft) | ✅ |
| Generics & constrained type parameters | 3 | ✅ |
| `unknown` vs `any`, type guards, narrowing | 1 | ✅ |
| Utility types (`Pick`, `Omit`, `Partial`, `Record`) | 3 | ◐ |
| Conditional & mapped types | later | ⬜ |
| `satisfies`, `as const`, deriving a union from data | 2 | ✅ |
| `strict` mode: what each flag actually buys | 0 | ✅ |

### PostgreSQL

| Topic | Phase | Status |
|---|---|---|
| Transactions, isolation, pooling | 1, 3, 7 (batch `SKIP LOCKED` claim) | ✅ |
| Index types: B-tree, GIN, GiST, partial, covering | 3+ | ✅ |
| `EXPLAIN ANALYZE` and reading a query plan | 3+ | ◐ |
| Constraints: CHECK, UNIQUE, EXCLUDE, deferrable | 1, 3 | ✅ |
| **Deferred constraint triggers: enforcing a multi-row invariant at `COMMIT`** | 3 (balance check), 3.8 (invoice partial immutability), 3.9 (payment allocation completeness + cross-transaction overallocation) | ✅ |
| Gapless(-ish) numbering: counter row + row lock vs `SEQUENCE` | 3.8 (invoice numbering) | ✅ |
| **Subledger reconciliation: derived document totals vs a GL control account balance** | 3.9 (AR/AP aging) | ✅ |
| Triggers & `updated_at`; CDC audit snapshots | 5 | ✅ |
| Passing request context to a trigger (`SET LOCAL` + `current_setting`) | 5 (audit actor + IP) | ✅ |
| `WITH RECURSIVE` CTEs + cycle detection | 3 (chart-of-accounts hierarchy), 3.6 (subtree balance rollups) | ✅ |
| Aggregate `FILTER` clauses, `generate_series` gap-filling | 3.5 (LedgerCore dashboard), 3.9 (`FILTER` over `UNION ALL`, correlated subqueries), 4 (P&L/balance sheet prior/current-year split) | ✅ |
| Composite foreign keys for cross-table tenancy checks | 3.5 (LedgerCore settings) | ✅ |
| Window functions (running balances, ledger reports) | 3.6 (LedgerCore account ledger) | ✅ |
| `EXCLUDE USING GIST` + `btree_gist` for date ranges | 4 (non-overlapping fiscal periods) | ✅ |
| `JSONB`: operators, indexing, when *not* to use it | 5 (audit snapshots), 6 (score breakdown), 10 (extractions) | ◐ |
| `pg_trgm` fuzzy search | dropped (was CRM) — Phase 6 scores in TypeScript instead | ⬜ |
| `pgvector`: similarity search, index types (IVFFlat/HNSW) | 16 (TaxGuard AI) | ⬜ |
| Partitioning strategies | later | ⬜ |
| Migration design: additive, idempotent, zero-downtime | 0–1 | ✅ |
| Content-addressed dedupe hashing, `ON CONFLICT DO NOTHING RETURNING` for atomic idempotent ingestion | 6 (bank statement re-import) | ✅ |
| Multi-currency: redefining an invariant without editing the applied migration, functional-currency balancing, CHECK-level rate agreement | 8 (FX engine) | ✅ |
| Partial unique indexes: a `WHERE`-scoped uniqueness check enforced at write time | 9b (one committed opening-balance import per org) | ✅ |

### React

| Topic | Phase | Status |
|---|---|---|
| Reconciliation, keys, render triggers | 1 | ✅ |
| Hook rules and why they exist (the call-order model) | 1 | ✅ |
| `useEffect` dependency array, cleanup, double-invoke in StrictMode | 1 | ✅ |
| Context: composition, re-render cost, splitting providers | 1 | ✅ |
| Nested routes, layout routes, dynamic segments | 2, 9a (hard vs. soft route gates) | ✅ |
| `useMemo` / `useCallback` / `React.memo` — when they actually help | 3+ | ◐ |
| Data fetching, races, cancellation, cache invalidation on org switch | 1–2 | ✅ |
| Controlled vs uncontrolled forms, discriminated-union wizard step state | 3 (multi-line journal entry), 3.5 (onboarding wizard) | ✅ |
| Utility-first CSS; Tailwind v4's CSS-first config | 3 | ✅ |
| React 19 specifics (`use`, Actions, compiler) | 1 | ✅ |
| Error boundaries & suspense | 3+ | ◐ |
| Accessible confirmation dialogs: ARIA roles, focus, dismissal | 3.8 (reverse/issue/void confirmations) | ✅ |
| Hand-rolled SVG charts: scaling, gap-filling, `role="img"`/shadow-table accessibility | 3.5 (trend chart), 3.9 (AR/AP aging bar chart) | ✅ |

### Architecture & patterns

| Topic | Phase | Status |
|---|---|---|
| Multi-tenancy isolation strategies | 1 | ✅ |
| Modular monolith: app boundaries without a network boundary | 2 | ✅ |
| Double-entry bookkeeping as an invariant system | 3 | ✅ |
| Append-only ledgers vs mutable counters | 3 | ✅ |
| Event sourcing vs CRUD — and where we sit | 3 | ✅ |
| Finite state machines for document lifecycle | 3.8 (invoices), 3.9 (bills — four states, a recall edge, role-gated approval), 4 (fiscal periods — a genuinely terminal state), 6 (bank transactions — a non-terminal reverse edge with a GL side effect), 9a (onboarding — a non-terminal "completed" state), 9b (migration imports — a backward edge that exists to prevent status/data drift), 10 (AP-Flow — an FSM with no terminal state anywhere in it) | ✅ |
| Staged import: validate-then-commit vs abort-on-first-error, and when each shape is right | 9b (chart-of-accounts / opening-balance import, contrasted against Phase 6's bank import) | ✅ |
| Idempotency keys for financial mutations | 9+ | ⬜ |
| **Enforcing an invariant in the DB vs the application — and why both** | 3 | ✅ |
| Edit distance (Levenshtein DP) & confidence scoring | 6 (bank reconciliation) | ✅ |
| Human-in-the-loop review: thresholds, explainable scores | 6, 11 | ◐ |
| Content-addressed storage & hash-based provenance | 9.5 (Document Vault — storage, dedup, org-keyed fan-out), 11 (AP-Flow — stamping the SHA-256 onto a journal entry so an auditor can walk from a ledger line back to the source) | ◐ |
| Multimodal extraction: structured output, per-field confidence | 10 (AP-Flow — forced tool use, decimal-string money, confidence as a routing signal) | ✅ |
| Finite state machines with no terminal state at all | 10 (AP-Flow — nothing posts yet, so nothing needs protecting from re-entry) | ✅ |
| Optimistic vs pessimistic concurrency control | dropped (was Inventory `FOR UPDATE`) | ⬜ |
| Layered architecture: controller / service / data | 0 | ✅ |
| Full request lifecycle across all five layers | 0 | ✅ |
| Immutability & reversing entries over mutation | 3 | ✅ |
| Derived state vs stored state (trade-offs) | 3–4, 3.9 (settlement derived from `payment_allocations`, never stored), 8 (the one deliberate stored-not-derived exception, `base_amount_cents`) | ✅ |
| FIFO / weighted-average-cost valuation algorithms | dropped (was Inventory) | ⬜ |
| 3-way matching (PO / receipt / invoice) | 11 (AP-Flow) | ⬜ |
| Recursive tree resolution & cycle detection | 3 (chart of accounts; was MRP/BOM) | ✅ |
| RAG: chunking, embeddings, retrieval, citation grounding | 16 (TaxGuard AI) | ⬜ |
| PII redaction before an external model call | 10 (AP-Flow images — done), 16 (TaxGuard text) | ◐ |
| Caching strategies & invalidation | 7+ | ⬜ |
| API versioning & backward compatibility | 0 | ✅ |
| Transactional outbox: the dual-write problem, at-least-once delivery | 7 (webhook events) | ✅ |
| Realized/unrealized FX gain-loss: the imbalance-as-plug technique, direction-agnostic sign, period-end revaluation with an automatic reversal | 8 (FX engine) | ✅ |

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
| File upload threat model: MIME spoofing, path traversal, zip bombs | 9.5 (Document Vault) | ✅ |
| Data minimisation: what you send a third party, and proving it | 10 (PII pixel masking — checksum-verified detection, destructive compositing, a raw-pixel acceptance test) | ✅ |
| HMAC request signing & timing-safe comparison | 7 (webhook delivery) | ✅ |
| SSRF: fetching a user-supplied URL, private-range guards, DNS rebinding | 7 (webhook endpoints) | ✅ |

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
