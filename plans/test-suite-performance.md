# Test suite performance — parallel integration testing

**Date:** 2026-09-18
**Status: DONE — 2026-09-19. 35.2 min -> 3.3 min (10.7x), zero failures.**

| Stage | Wall | Tests |
|---|---|---|
| Baseline (serial, dev cluster, fsync on) | **35.2 min** | 1600 / 1598 pass / 2 skip |
| + `postgres-test` cluster (fsync=off) + `sandbox.test.ts` restructure | **7.3 min** | 1599 / 1597 pass / 2 skip |
| + `fileParallelism: true`, `maxWorkers: 3` | **3.3 min** | 1599 / 1597 pass / 2 skip |

Verified with two consecutive green runs plus a dedicated isolation pass
(`tenantIsolation` 9/9; 70 isolation cases across 26 files). Total is 1599 not
1600 because two overlapping sandbox cases were merged — no assertion was lost.

**Slice 4 (the `unit`/`integration` project split) was NOT built** — see the
note at its heading. Slice 5.2 (study note) was skipped at the user's direction.

Requires `docker compose up -d postgres-test redis`.

Make `npm test` fast enough to run routinely, without weakening what it proves. No test is deleted, skipped, or loosened by this plan.

---

## Starting state (verified against the filesystem, 2026-09-18)

**Server suite — `server/src/__tests__/`**

| Fact | Value | Source |
|---|---|---|
| Test files | 126 | `find src/__tests__ -name '*.test.ts'` |
| `it()`/`test()` calls | ~1510 (CLAUDE.md claims 1598 incl. `it.each` expansion) | grep |
| Vitest | 4.1.10 | `node_modules/vitest/package.json` |
| Parallelism | **off** — `fileParallelism: false` | `server/vitest.config.ts` |
| Test database | one shared `autodb_test` | `src/__tests__/setup/testDatabase.ts` |
| Files calling `resetTables()` in `beforeEach` | 93 of 126 (TRUNCATE of ~60 tables per test) | grep, `--include='*.test.ts'` |
| Files calling `createUserWithOrg` | 91; ~3,578 fixture users per full run | grep, tests x users-per-`beforeEach` |
| Files importing `app.js` | 72 — pulls `routes/index.ts` → all 19 routers → all 80 services | grep |
| Migrations | 56 files, 5052 SQL lines | `ls src/db/migrations/` |
| Skipped tests | 2, gated live-provider cases (`AP_FLOW_OCR_E2E`, `AP_FLOW_GEMINI_E2E`) | CLAUDE.md |

**Client suite** — 51 files, 261 tests, **34s wall**. Measured this session. Fast enough. **Out of scope; do not touch `client/vitest.config.ts`.**

**The three shared mutable resources all already funnel through `config/env.ts`** — this is what makes this plan a setup-layer change that touches none of the 126 test files:

| Resource | Read at | Currently pinned to |
|---|---|---|
| `PG_DATABASE` | `src/config/env.ts:114` (`required`) | `autodb_test` |
| `REDIS_DB` | `src/config/env.ts:121` (`nonNegativeInteger`, default 0) | `1` |
| `STORAGE_ROOT` | `src/config/env.ts:126` (`path.resolve(process.cwd(), ...)`) | `storage-test` |

All three are resolved **at module import time** from `process.env`. No test hardcodes any of them: `storageService.test.ts:15` and `factories.ts:100` both use `env.STORAGE_ROOT`; every Redis connection goes through `createRedisConnection()` (`src/queue/connection.ts:21-24`) reading `db: env.REDIS_DB`; only `globalSetup.ts` and `testDatabase.ts` mention `autodb_test`.

**Verified Vitest 4.1.10 API facts** (do not substitute from memory of other versions):

- `maxWorkers?: number | string` exists in `InlineConfig` (`reporters.d.DtoKVV2s.d.ts:2848`).
- **`poolOptions.forks.maxForks` does NOT exist in this version.** The exported `PoolOptions` (line 2058) is an internal runtime type (`distPath`/`project`/`method`), not user config. Use `maxWorkers`. `minWorkers` is absent.
- `setupFiles?: string | string[]` and `globalSetup?: string | string[]` both live in `InlineConfig` (opens line 2732), which project configs extend.
- `projects?: TestProjectConfiguration[]` exists (line 2859).
- Both `VITEST_WORKER_ID` (5 occurrences) and `VITEST_POOL_ID` (2) are present in the 4.1.10 runtime.

**Machine:** 4-core AMD Ryzen 3 4300U, 7.3 GB RAM, **swap 91% full (1862/2047 MB)**. Memory, not cores, is expected to bind first — each fork re-imports all 80 services plus `sharp`/`pdfjs`/`tesseract`.

**What does not exist:** no CI (`.github/workflows` absent), no git hooks, no `test:unit`/`test:integration` scripts.

**Environment is currently broken.** `dockerd`/`containerd` are inactive; ports 5432/6379 hold orphaned listening sockets with no owning process, so connections hang instead of refusing. **No timing has been measured.** The only figure on record is `docs/roadmap.md:728` — *"it takes ~30 minutes against real Postgres"* — recorded at 1455 tests. Treat it as an unverified prior, not a baseline.

---

## Gate

This is **test infrastructure, not a roadmap phase.** It adds no migration, no table, no route, no dependency. Phase 19.4 is the current head and nothing here is gated behind an unbuilt phase.

Governing rules from [CLAUDE.md](../CLAUDE.md):

- **Rule 14 — no new dependency.** Everything here uses Vitest built-ins and `pg`, both already present. If a step seems to need a package, that step is wrong: stop and report.
- **Rule 15 — every module ships tests, including cross-tenant isolation.** This plan must not weaken one. The per-app isolation tests are the acceptance criterion for Slices 1–3.
- **Rule 13 — migrations.** No migration is added or edited. `runMigrations()` is called exactly as today, against the template only.

---

## Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

Anything this plan did not anticipate is a **stop-and-report, not a judgment call.**

| Symptom | Forbidden | Correct |
|---|---|---|
| A test fails once parallel | Deleting, skipping, or `.only`-ing it | Find the shared resource it collides on; report it |
| A test is flaky under parallel | `--retry`, or reordering to hide it | Stop. Flakiness here means a real shared-state leak |
| Cross-tenant isolation test fails | Weakening the assertion | Stop immediately — this is the suite's whole point (rule 1) |
| Type error in config | `as any`, `@ts-ignore` | Fix the type against the verified shapes above |
| `CREATE DATABASE ... TEMPLATE` fails "source database is being accessed" | Dropping the template, `pg_terminate_backend` loops | Ensure `closePool()` ran first; report if it persists |
| Needs a helper library | `npm install` anything | Stop and ask (rule 14) |
| Out of memory / machine swaps hard | Raising `maxWorkers` to "get through it" | Lower `maxWorkers` to 2, re-measure, report |
| Migration checksum error | Editing an applied migration | A new sequential migration (rule 13) |
| Tempted to edit a test file | Any edit to the 126 test files | **This plan changes zero test files.** Stop and report |

**Hard invariant: Slices 0–4 modify no file under `src/__tests__/` except `setup/` and `helpers/factories.ts`.** If you find yourself editing a `*.test.ts`, the plan is wrong — stop.

---

## Slice 0 — Make a dead database fail fast, and measure

**Outcome:** `npm test` against a down/hung Postgres errors in seconds with an actionable message, and a real baseline number exists.

This slice is first because it is a genuine bug, it cost this project 34 minutes of silent hang today, and **every later slice is sized by the measurement it produces.**

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| File (edit) | `server/src/__tests__/setup/globalSetup.ts` |
| Constant (new) | `ADMIN_CONNECT_TIMEOUT_MS = 5000` |
| Baseline artifact | `plans/test-baseline.json` (git-ignored scratch, delete in Slice 5) |

### Step 0.1 — Give globalSetup's admin client a connection timeout

- **Depends on:** nothing
- **Skill:** none (setup-layer edit) — same fields apply
- **Read first:** `server/src/__tests__/setup/globalSetup.ts` in full. Note the existing `catch` at the `admin.connect()` call already writes the correct error text and already calls `admin.end()` to release the socket — you are making that path reachable, not writing a new one.
- **Files:** `server/src/__tests__/setup/globalSetup.ts` (edit — the `new Client({...})` literal, and the Redis `new Redis({...})` literal)
- **Contract — write these literally:**

  Add above the `Client` construction:
  ```ts
  /**
   * Without this, a Postgres whose port is open but which never accepts
   * (a dead container behind a stale docker-proxy socket, a paused VM)
   * hangs globalSetup forever: pg's default connect timeout is unlimited.
   * The friendly error below only fires on ECONNREFUSED, so the one
   * failure mode that actually happens produced a silent 30-minute stall.
   */
  const ADMIN_CONNECT_TIMEOUT_MS = 5000;
  ```
  Add to the `new Client({...})` options object, after `database: 'postgres',`:
  ```ts
  connectionTimeoutMillis: ADMIN_CONNECT_TIMEOUT_MS,
  ```
  In the existing `catch` block around `admin.connect()`, leave the message text unchanged but append this sentence to the thrown string, before the `err.message` interpolation:
  ```
  'If the port is open but this timed out, the container is not accepting connections — restart it.\n  '
  ```
  The Redis client already sets `maxRetriesPerRequest: 1` and `lazyConnect: true`; add to its options:
  ```ts
  connectTimeout: ADMIN_CONNECT_TIMEOUT_MS,
  ```
- **Guardrails:** #14 no new dependency — `pg` and `ioredis` are already imported here
- **Proof:** with Postgres **stopped**, `cd server && time npm test 2>&1 | head -20` exits non-zero in **under 15 seconds** and prints `Could not reach PostgreSQL for the integration tests`. Today this hangs indefinitely — that contrast is the proof.
- **If it fails:** if it still hangs, the timeout is not reaching the client — verify you edited the `Client` in `globalSetup.ts` and not `db/connect.ts`. Do not add a `Promise.race` wrapper.
- **Owes:** a line in the Slice 5 study note — this is a real mechanism (open port ≠ accepting socket)

### Step 0.2 — Record the baseline

- **Depends on:** Step 0.1; **Postgres and Redis running**
- **Skill:** none
- **Read first:** nothing
- **Files:** none (writes `plans/test-baseline.json`)
- **Contract — run exactly:**
  ```bash
  cd server && docker compose -f ../docker-compose.yml up -d postgres redis
  npx vitest run --reporter=json --outputFile.json=../plans/test-baseline.json
  ```
  Then record, in your report: total wall seconds, pass/fail/skip counts, and the **ten slowest files** by duration.
- **Guardrails:** none
- **Proof:** `plans/test-baseline.json` is non-empty and its `numTotalTests` is ≥ 1500 with `numFailedTests` **0** (2 skipped expected). A non-zero failure count here means the suite is red *before* any change — **stop and report; do not proceed into Slice 1 on a red baseline.**
- **If it fails:** if Postgres will not start because 5432 is held by an orphaned socket, reboot. Do not bind an alternate port — `server/.env` and every fixture assume 5432.
- **Owes:** nothing

---

## Slice 1 — Per-worker resource isolation (parallelism still OFF)

**Outcome:** each Vitest worker owns a private database, Redis index, and storage directory — while the suite still runs serially and stays green. This slice changes *what resources a worker uses*, not *how many run at once*, so a regression here is unambiguous.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Template DB (existing const, unchanged value) | `TEST_DATABASE = 'autodb_test'` in `setup/testDatabase.ts` |
| New const | `TEST_MAX_WORKERS = 3` in `setup/testDatabase.ts` |
| Per-worker DB names | `autodb_test_1`, `autodb_test_2`, `autodb_test_3` |
| New file | `server/src/__tests__/setup/workerResources.ts` |
| Its exports | `WORKER_INDEX`, `workerDatabase`, `workerRedisDb`, `workerStorageRoot` |
| New file | `server/src/__tests__/setup/perWorkerEnv.ts` (a `setupFiles` entry, no exports) |
| Storage roots | `storage-test-1`, `storage-test-2`, `storage-test-3` |
| Redis indices | 1, 2, 3 (never 0 — that is the dev queue) |

### Step 1.1 — `workerResources.ts`: derive every per-worker name from the worker index

- **Depends on:** Step 0.2 (green baseline)
- **Skill:** none
- **Read first:** `server/src/__tests__/setup/testDatabase.ts` — copy its comment style and its "imported by both config and setup" rationale.
- **Files:** `server/src/__tests__/setup/testDatabase.ts` (edit — add one const), `server/src/__tests__/setup/workerResources.ts` (new)
- **Contract — write these signatures literally:**

  In `testDatabase.ts`, add below the existing export:
  ```ts
  /**
   * How many parallel workers the integration project may use, and therefore
   * how many database clones globalSetup creates.
   *
   * 3, not 4 (the core count): each fork re-imports all 80 services plus
   * sharp/pdfjs/tesseract, and this machine has 7.3 GB with swap already
   * under pressure. Memory binds before cores do here.
   */
  export const TEST_MAX_WORKERS = 3;
  ```
  New file `workerResources.ts` — **this file must import nothing**. It is loaded before `config/env.ts` and any import that transitively pulls `env.ts` would freeze the old values:
  ```ts
  export const WORKER_INDEX: number;
  export function workerDatabase(index?: number): string;   // `autodb_test_${index}`
  export function workerRedisDb(index?: number): number;    // index
  export function workerStorageRoot(index?: number): string; // `storage-test-${index}`
  ```
  `WORKER_INDEX` is computed exactly as:
  ```ts
  const raw = process.env.VITEST_POOL_ID ?? '1';
  const parsed = Number.parseInt(raw, 10);
  export const WORKER_INDEX = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  ```
  **Amended during execution:** `VITEST_POOL_ID` only. Vitest's source documents it as "between 1-`maxWorkers`"; `VITEST_WORKER_ID` is a per-task counter that grows across isolated files (indices like 40 → nonexistent `autodb_test_40` → 1058 failures in the first Step 1.4 run). The original `WORKER_ID ?? POOL_ID` order in this plan was wrong.
- **Guardrails:** #14 no dependency; this file imports nothing at all
- **Proof:** `cd server && npm run typecheck` exits 0, and `grep -c "^import" src/__tests__/setup/workerResources.ts` returns **0**.
- **If it fails:** if typecheck complains about `process.env` typing, `@types/node` is already a devDependency — do not add it. Never `as any`.
- **Owes:** nothing yet

### Step 1.2 — `perWorkerEnv.ts`: point each worker at its own resources

- **Depends on:** Step 1.1
- **Skill:** none
- **Read first:** `server/src/config/env.ts` lines 106–130 — confirm for yourself that `PG_DATABASE`, `REDIS_DB` and `STORAGE_ROOT` are read at module-evaluation time. That is the entire reason this file must run first and import nothing.
- **Files:** `server/src/__tests__/setup/perWorkerEnv.ts` (new)
- **Contract — the whole file, literally:**
  ```ts
  /**
   * A `setupFiles` entry, which Vitest evaluates in the worker BEFORE it
   * imports the test file — and therefore before anything imports
   * config/env.ts, which resolves these three at import time (env.ts:114,
   * 121, 126). Writing them here is what gives each worker its own database,
   * Redis index and storage directory.
   *
   * Imports only ./workerResources.js, which itself imports nothing. Any
   * import here that transitively reaches config/env.ts would evaluate it
   * against the pre-override values and silently put every worker back on
   * one database.
   */
  import { workerDatabase, workerRedisDb, workerStorageRoot } from './workerResources.js';

  process.env.PG_DATABASE = workerDatabase();
  process.env.REDIS_DB = String(workerRedisDb());
  process.env.STORAGE_ROOT = workerStorageRoot();
  ```
- **Guardrails:** #14
- **Proof:** `cd server && npm run typecheck` exits 0.
- **If it fails:** do not move these assignments into `vitest.config.ts`'s static `env` block — that block cannot vary per worker, which is the whole problem.
- **Owes:** nothing yet

### Step 1.3 — globalSetup: build the template once, clone it per worker

- **Depends on:** Step 1.1, Step 1.2
- **Skill:** none
- **Read first:** `server/src/__tests__/setup/globalSetup.ts` (as amended in Step 0.1) — keep its existing structure, its dynamic-import ordering comments, and its `closePool()` call. You are extending the middle, not rewriting the file.
- **Files:** `server/src/__tests__/setup/globalSetup.ts` (edit)
- **Contract:**

  Keep all existing behaviour: create `autodb_test` if absent, run `runMigrations()` against it, `closePool()`. `autodb_test` is now the **template** and no worker connects to it.

  After `closePool()` and before the Redis block, add a clone loop. For `index` from `1` to `TEST_MAX_WORKERS`, on the same admin `Client` (reopen one — the earlier one was closed):
  ```sql
  DROP DATABASE IF EXISTS "autodb_test_<index>" WITH (FORCE);
  CREATE DATABASE "autodb_test_<index>" TEMPLATE "autodb_test";
  ```
  Identifiers are quoted with `"` and the name comes from `workerDatabase(index)`, never from user input. `WITH (FORCE)` requires PostgreSQL 13+; the image is `pgvector/pgvector:pg16`, so it is available. Drop-then-create each run so a new migration can never leave a stale clone behind — cloning is a file-level copy and costs far less than re-running 56 migrations per database.

  Replace the Redis flush with a loop over the same range, flushing db `workerRedisDb(index)` for each, reusing the existing connection-error handling verbatim.

  Log once after the loop: `` console.log(`[test] prepared ${TEST_MAX_WORKERS} worker database(s) from template ${TEST_DATABASE}`) ``
- **Guardrails:** #4 — identifiers cannot be parameterised, so quote-and-escape exactly as the existing `CREATE DATABASE` line already does (`.replace(/"/g, '""')`). #13 — `runMigrations()` still runs once, against the template only.
- **Proof:** `cd server && npm test 2>&1 | tail -20` — the suite is **green, same counts as the Slice 0 baseline**, and the log line appears. Then `psql -l` (or any client) shows `autodb_test`, `autodb_test_1`, `autodb_test_2`, `autodb_test_3`.
- **If it fails:** `source database is being accessed by other users` means something still holds the template — confirm `closePool()` runs before the loop. Do not add a `pg_terminate_backend` sweep.
- **Owes:** nothing yet

### Step 1.4 — Wire the setup file in, still serial

- **Depends on:** Step 1.3
- **Skill:** none
- **Read first:** `server/vitest.config.ts` in full — preserve every existing comment, especially the `env` block's Phase 19/19.2 provider-pinning rationale.
- **Files:** `server/vitest.config.ts` (edit)
- **Contract:**
  - Add `setupFiles: ['src/__tests__/setup/perWorkerEnv.ts'],` directly above the existing `globalSetup` line.
  - **Remove** `PG_DATABASE: TEST_DATABASE,` from the `env` block and delete its now-stale import if unused; `perWorkerEnv.ts` owns this now. Leave `REDIS_DB` and `STORAGE_ROOT` in the `env` block as harmless defaults for a worker that somehow skips setup.
  - **Leave `fileParallelism: false` exactly as it is.** Replace only its closing sentence ("When it does start to hurt, the fix is Vitest `projects`...") with: `Flipped on in Slice 2 of plans/test-suite-performance.md, once each worker owns its own database.`
- **Guardrails:** #14
- **Proof:** `cd server && time npm test 2>&1 | tail -20` — green, **same test counts as baseline**, and wall time within ±15% of it. A large change here means workers are not landing where you think; stop.
- **If it fails:** if every test suddenly fails on a missing table, `perWorkerEnv.ts` ran too late or the clones do not exist — re-check Step 1.3's proof before touching anything else.
- **Owes:** nothing yet

---

## Slice 2 — Turn parallelism on

**Outcome:** integration files run 3-wide, green, with cross-tenant isolation intact.

### Step 2.1 — Flip `fileParallelism` and cap workers

- **Depends on:** Slice 1 complete and green
- **Skill:** none
- **Read first:** `server/vitest.config.ts`
- **Files:** `server/vitest.config.ts` (edit)
- **Contract:**
  - Change `fileParallelism: false` → `fileParallelism: true`.
  - Add `maxWorkers: TEST_MAX_WORKERS,` immediately below it, importing the constant from `./src/__tests__/setup/testDatabase.js` alongside the existing import.
  - **Use `maxWorkers`. Do not write `poolOptions.forks.maxForks` — it does not exist in Vitest 4.1.10** (verified against `node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts`).
  - Rewrite the `fileParallelism` comment to state the new invariant: files may run in parallel **because** each worker owns `autodb_test_<n>`, Redis db `<n>` and `storage-test-<n>`; the cap is memory-driven, not core-driven.
- **Guardrails:** #1 — the per-app cross-tenant isolation tests are the acceptance criterion; they must pass unchanged
- **Proof:** `cd server && time npm test 2>&1 | tail -30` — green, **test counts identical to the Slice 0 baseline**, 2 skipped. Run it **twice in a row**; both green. Report old vs new wall time. Separately confirm no isolation regression: `npm test -- tenantIsolation` passes.
- **If it fails:**
  - A handful of files failing on missing/extra rows = a shared resource remains. Report which files and which table. Do not add `--retry`.
  - Machine swapping hard or an OOM kill: set `TEST_MAX_WORKERS = 2`, re-run, report both numbers. Do not raise it above 3.
  - **Any cross-tenant isolation failure: stop immediately and report.** That is never something to work around.
- **Owes:** the study note's core section (Slice 5)

---

## Slice 3 — Stop paying for durability the tests do not need — **SUPERSEDED**

**Replaced during execution by a separate test cluster.** The original step set
`synchronous_commit = off` per clone database. Measurement showed that was aimed
at the wrong thing:

| Operation | fsync=on | fsync=off |
|---|---|---|
| `TRUNCATE` all 55 tables | **2055 ms** | **69 ms** |
| single committed `INSERT` | 4.6 ms | 1.1 ms |

`resetTables()` runs before almost every one of ~1500 DB-backed tests, and
`TRUNCATE` fsyncs a fresh relation file per table *and per index*.
`synchronous_commit` governs WAL flush at commit and does nothing for that;
`fsync` governs it entirely — a **30x** difference and the single largest cost
in the suite.

`fsync` is cluster-wide, so it cannot be set per test database. Instead
`docker-compose.yml` gained a **`postgres-test` service on port 5433** running
`fsync=off full_page_writes=off synchronous_commit=off autovacuum=off`, leaving
the dev cluster on 5432 fully durable. `TEST_PG_PORT` in `setup/testDatabase.ts`
carries the port; `globalSetup.ts` and `perWorkerEnv.ts` both pin it, for the
same reason they pin `PG_DATABASE`.

A conditional `resetTables()` (probe with `EXISTS`, truncate only dirty tables)
was designed and then **dropped**: at 69 ms there is nothing left to optimise,
and `TRUNCATE organizations CASCADE` alone still cost 974 ms with fsync on
because nearly every table has an `org_id` FK — so it would have bought ~2x
where the cluster change buys 30x, at the price of real complexity.

## Slice 4 — The two-lane split — **NOT BUILT (deliberate)**

Left unbuilt once the suite reached 3.3 minutes. The split's value was escaping
a 35-minute full run; at 3.3 min the full suite is runnable on every change, and
a targeted run (`npx vitest run ledger-core`) already gives a sub-30s inner loop
with no config at all. Set against that, the `unit` project needed a hand-
maintained list of 30 file paths — "does not call `resetTables`" is *not* the
same as "needs no database" (`health.test.ts` proves it), so it could not be a
glob — and a list that rots silently, failing only when someone runs it with
Postgres down, is a poor trade for ~3 minutes.

Revisit if the suite creeps back above ~10 minutes. The original design follows.

## Slice 4 (original design, unbuilt) — The two-lane split ("only the relevant ones")

**Outcome:** `npm run test:unit` runs the database-free tests in seconds for the inner loop; `npm test` still runs everything.

**Why not `vitest --changed`:** it selects by module-graph reachability, and 72 of 126 test files import `app.js`, which imports `routes/index.ts` → all 19 routers → all 80 services. Changing any service marks ~72 files as affected. It is technically correct and useless here. Do not add it.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| Project names | `unit`, `integration` |
| Scripts | `test:unit`, `test:integration` |

### Step 4.1 — Split `vitest.config.ts` into two projects

- **Depends on:** Slice 3 green
- **Skill:** none
- **Read first:** `server/vitest.config.ts`
- **Files:** `server/vitest.config.ts` (edit)
- **Contract:**

  Move the current `test` body into `test.projects: [...]` with two entries. Keep `coverage` at the **root** `test` level, unchanged.

  **`unit` project** — `globals: true`, `environment: 'node'`, **no `globalSetup`**, `setupFiles: ['src/__tests__/setup/perWorkerEnv.ts']` (still needed: two of these files touch the filesystem), `fileParallelism: true`, `maxWorkers: TEST_MAX_WORKERS`, and the same `env` block **minus** `PG_DATABASE`.

  Its `include` is this explicit list of **30 files** — every `src/__tests__/` path below, and nothing else:

  ```
  ap-flow/autoPostPolicy.test.ts      ap-flow/extraction.test.ts
  ap-flow/modelClient.test.ts         boarddeckVariance.test.ts
  checksum.test.ts                    csv.test.ts
  dateParse.test.ts                   fiscalYear.test.ts
  forecasterBuild.test.ts             fxRate.test.ts
  integrations/googleDriveClient.test.ts
  integrations/serviceAccountAuth.test.ts
  jwt.test.ts                         levenshtein.test.ts
  matchScore.test.ts                  microUsd.test.ts
  mimeSniff.test.ts                   money.test.ts
  pii.test.ts                         platform/sandboxFixtures.test.ts
  queryParam.test.ts                  rateLimit.test.ts
  rbac.test.ts                        redaction.test.ts
  secretBox.test.ts                   storageService.test.ts
  taxActParse.test.ts                 uniteconCohort.test.ts
  uniteconPvm.test.ts                 validate.test.ts
  ```

  Three exclusions are deliberate and must not be "fixed" by adding them back:
  - `app.test.ts` and `health.test.ts` import `app.js`; `health.test.ts` performs a real `SELECT 1`.
  - `platform/queue.test.ts` needs a real Redis.

  **`integration` project** — everything else: `include: ['src/__tests__/**/*.test.ts']`, `exclude` set to the 30 paths above, plus the current `globalSetup`, `setupFiles`, `env`, `fileParallelism: true`, `maxWorkers: TEST_MAX_WORKERS`.

  Add above `projects`:
  ```ts
  /**
   * Two lanes. `unit` needs no database and no Redis, so it carries no
   * globalSetup and runs in seconds — the inner loop. `integration` owns the
   * real Postgres. The unit list is explicit, not a glob: "does not call
   * resetTables" is NOT the same as "needs no database" (health.test.ts
   * proves it), and a wrong guess here fails only when the database is down.
   * A new database-free test file must be added to this list by hand.
   */
  ```
- **Guardrails:** #14
- **Proof:** three commands, all required:
  1. `cd server && npm test` — green, **test counts identical to the Slice 0 baseline** (the split must not lose a file).
  2. `npx vitest run --project=unit` — green, and **under 30 seconds**.
  3. **The decisive one:** stop Postgres and Redis, then `npx vitest run --project=unit` — still green. If any test fails, that file is misclassified: move it to `integration` and report which.
- **If it fails:** if the counts in (1) do not match baseline, a file is in both lanes or neither — fix the `exclude`, never by editing a test file.
- **Owes:** the `docs/testing.md` rewrite in Slice 5

### Step 4.2 — Scripts

- **Depends on:** Step 4.1
- **Skill:** none
- **Read first:** `server/package.json`
- **Files:** `server/package.json` (edit — `scripts` only)
- **Contract:** add exactly these two, leaving `test`, `test:watch`, `test:coverage` unchanged:
  ```json
  "test:unit": "vitest run --project=unit",
  "test:integration": "vitest run --project=integration",
  ```
- **Guardrails:** #14 — no dependency changes in this edit
- **Proof:** `cd server && npm run test:unit` green in under 30s; `npm run test:integration` green.
- **If it fails:** nothing to improvise; report.
- **Owes:** `docs/development.md` mention in Slice 5

---

## Slice 5 — The spine

### Step 5.1 — `guardrail-review` over the full diff

- **Depends on:** Slices 0–4
- **Skill:** **guardrail-review**
- **Files:** the whole diff (`git diff`)
- **Contract:** confirm specifically: no test file under `src/__tests__/` was modified except `setup/*`; no `org_id` predicate was removed anywhere; no migration added or edited; `package.json` `dependencies`/`devDependencies` byte-identical to `git show HEAD:server/package.json`.
- **Proof:** `git diff --stat HEAD -- server/src/__tests__/ | grep -v "setup/"` prints nothing, and `git diff HEAD -- server/package.json` shows only the two new scripts.
- **If it fails:** revert the offending file rather than justifying it.
- **Owes:** nothing

### Step 5.2 — Study note

- **Depends on:** Step 5.1
- **Skill:** **study-note**
- **Read first:** `study/tooling/testing-with-vitest.md` — it already names this fix without having built it, at line 277 (TRUNCATE vs transaction-rollback) and line 373 ("Vitest parallelises files, so DB-backed suites need `fileParallelism: false` **or a database per worker**"). **Extend that file; do not create a new one.**
- **Files:** `study/tooling/testing-with-vitest.md` (edit), `study/README.md` (edit)
- **Contract:** add a section **"Parallel integration tests: a database per worker"** covering, at mechanism depth:
  - Why a shared test database forces `fileParallelism: false`, and what the failure looks like (fixtures deleted mid-assertion, presenting as a phantom tenant-isolation bug).
  - `CREATE DATABASE ... TEMPLATE` as a file-level copy vs re-running 56 migrations per clone; why `WITH (FORCE)` needs PG 13+; why the template must have no connections.
  - **The `setupFiles` ordering mechanism** — `config/env.ts` resolves `PG_DATABASE`/`REDIS_DB`/`STORAGE_ROOT` at import time, so a setup file that runs first and imports nothing is what makes per-worker overrides possible. Name the trap: one stray import of `env.ts` silently collapses every worker back onto one database.
  - `ALTER DATABASE ... SET synchronous_commit = off` — why it is per-database, why it is not copied by `TEMPLATE`, why it is safe for tests and not for `autodb`.
  - **Why `vitest --changed` fails on this codebase** — module-graph reachability through `routes/index.ts`, with the real 72-of-126 number.
  - **Open port ≠ accepting socket** — the orphaned-listener incident: a `pg.Client` with no `connectionTimeoutMillis` waits forever, and an error path written for `ECONNREFUSED` never fires.
  - Alternatives rejected: transaction-per-test with `ROLLBACK` (ruled out — the services own their own `BEGIN`/`COMMIT`, already noted at line 277); `threads` pool (native `pg`/`sharp` risk, already at line 83); `--retry` (hides shared-state bugs).
  - **4–8 interview questions with full written answers.**
  - State the verified version: **Vitest 4.1.10, PostgreSQL 16 (`pgvector/pgvector:pg16`)**. Flag that `VITEST_WORKER_ID` vs `VITEST_POOL_ID` is undocumented for the forks pool and the code reads both.
  - In `study/README.md`, add a row to the **Testing & tooling** table (opens line 266): `| Parallel integration tests: database per worker, template cloning, setupFiles ordering | — | ✅ |`, and a matching index-table row pointing at the note.
- **Proof:** the note states its verified versions; `study/README.md` has both new rows; every claim traces to a file in this repo.
- **If it fails:** accuracy outranks completeness — cut a bullet rather than guess. Flag anything unverified in the note itself.
- **Owes:** nothing

### Step 5.3 — `docs-sync`

- **Depends on:** Step 5.2
- **Skill:** **docs-sync**
- **Read first:** `docs/testing.md` — it is **already stale**: it claims "868 server tests + 172 client tests (as of Phase 9.5)" and a file table last re-verified at Phase 7.
- **Files:** `docs/testing.md` (edit), `docs/development.md` (edit), `CLAUDE.md` (edit, one line only)
- **Contract:**
  - `docs/testing.md`: correct the counts to the measured Slice 0 numbers plus the client's 261. Replace the `fileParallelism: false` subsection — it currently states the rule this plan reverses — with the two-lane model, the per-worker resource table, and the rule that **a new database-free test file must be added to the `unit` project's include list by hand**. Document `npm run test:unit` / `test:integration`. Keep the `autodb_test`-not-`autodb` discipline section; it is still true, now about the template.
  - `docs/development.md`: add `npm run test:unit` as the inner-loop command.
  - `CLAUDE.md`: update only the test-count figures in the Phase 19.4 line. **Do not add a section** — that file is a short index on purpose.
  - Do **not** add a roadmap phase entry; this is not a phase.
- **Proof:** `grep -n "868\|fileParallelism: false" docs/testing.md` prints nothing; the stated counts match Slice 0's `plans/test-baseline.json`.
- **If it fails:** stop; a wrong number in `docs/` is the exact drift that killed the prior build.
- **Owes:** nothing

### Step 5.4 — Close the plan

- **Depends on:** 5.1–5.3
- **Skill:** none
- **Files:** `plans/test-baseline.json` (delete), `plans/test-suite-performance.md` (edit → `Status: Done <date>`, or delete)
- **Contract:** delete the baseline artifact; set this file's `Status:` line to done with the before/after wall times, or delete the file.
- **Proof:** `git status --short` shows only intended changes.
- **If it fails:** n/a
- **Owes:** nothing

---

## Deferred — not in this plan

**The 44-account chart per fixture user.** Every `createUserWithOrg` runs the real `register()`, which seeds 44 accounts via `seedDefaultChart` (`accountService.ts:436`) — ~157k account rows inserted and truncated per run for tests that mostly want "a user in an org". An opt-out (`createUserWithOrg({ chart: false })`) is the obvious next lever.

**It is deliberately excluded** because it is the only candidate change that touches fixture semantics used by 91 files, and because its value is unknown until Slice 2 and 3 are measured. **Do not attempt it as part of this plan.** If, after Slice 3, the suite is still slower than ~5 minutes, raise it as a new plan with its own measurement.

---

## Risks & open questions

| Risk | Status |
|---|---|
| **No baseline exists.** Postgres/Redis are down; the ~30 min figure is `docs/roadmap.md:728`'s unverified prior. Every "improvement" claim in this plan is unquantified until Step 0.2 runs. | **Open — blocking.** Requires the user to start Docker (password-required sudo; not in `docker` group; no `docker.sock`) |
| **Memory, not cores, may bind.** 7.3 GB with swap 91% full; each fork loads all 80 services plus `sharp`/`pdfjs`/`tesseract`. | Mitigated: `TEST_MAX_WORKERS = 3`, explicit fallback to 2 in Step 2.1 |
| `VITEST_WORKER_ID` vs `VITEST_POOL_ID` for the forks pool is undocumented | Mitigated: both read, fallback to `1`. Verified both strings exist in the 4.1.10 runtime |
| Project-level `globalSetup`/`setupFiles` in `test.projects` | `InlineConfig` (line 2732) declares both, and projects extend it. **Not executed against this version** — if Step 4.1's proof (1) fails on config shape, report rather than improvising |
| A hidden shared resource beyond DB/Redis/storage surfaces under parallelism | Slice 1 isolates resources *before* Slice 2 enables concurrency, so a failure is attributable to one slice |
| The `unit` include list rots as tests are added | Accepted. Documented in `docs/testing.md` (Step 5.3) and in the config comment. The Step 4.1 proof — unit lane green with Postgres **stopped** — catches misclassification immediately |
| 7 files use bullmq `Queue`/`Worker`; per-worker Redis indices 1–3 (Redis default is 16 databases) | Low. `queue.test.ts` is in the integration lane |
| Docker itself is broken on this machine (`dockerd` inactive, orphaned 5432/6379 sockets) | **Out of scope.** May need a reboot before Step 0.2 |

**Unknown, stated plainly:** the actual wall time, the ten slowest files, and therefore whether Slices 2–3 alone reach a tolerable number. Slice 4 is included regardless because the fast inner loop has value independent of how fast the full suite gets.

---

## Definition of done

1. `npm test` green — **test counts identical to the Slice 0 baseline**, 2 skipped, zero failures, on two consecutive runs.
2. Every per-app cross-tenant isolation test passes unchanged (rule 15).
3. `npm run test:unit` green in under 30 seconds **with Postgres and Redis stopped**.
4. `npm test` against a down Postgres fails in under 15 seconds with the actionable message (Slice 0).
5. Zero files changed under `src/__tests__/` except `setup/`; zero migrations; `dependencies`/`devDependencies` unchanged.
6. `guardrail-review` clean.
7. `study/tooling/testing-with-vitest.md` extended with the mechanism section and 4–8 Q&A; `study/README.md` index and coverage rows added.
8. `docs/testing.md`, `docs/development.md`, `CLAUDE.md` counts match reality; `plans/test-baseline.json` deleted; this file closed.
9. Before/after wall times reported for baseline → Slice 2 → Slice 3.
