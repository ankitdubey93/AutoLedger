# Development — Running the Stack

**Model: infrastructure in Docker, application processes on the host.**

PostgreSQL and Redis run as containers. The Express server and Vite client run from your own terminals with native file watching. There is no `server/Dockerfile`, no `client/Dockerfile`, and no `entrypoint.sh` — see [Why not full Docker](#why-not-full-docker).

Requires **Node 22+** and Docker with the Compose v2 plugin.

## First-time setup

```bash
# from the project root
cp .env.example .env                  # Postgres/Redis credentials for docker compose
cp server/.env.example server/.env    # server config + secrets
cp client/.env.example client/.env    # VITE_API_BASE_URL

(cd server && npm install)
(cd client && npm install)
```

Three `.env` files, deliberately: root is read *only* by `docker-compose.yml`, `server/.env` is read by the server process, `client/.env` is inlined into the browser bundle by Vite. `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` must agree between the root and server files.

## Every session

```bash
docker compose up -d          # postgres :5432, redis :6379
```

```bash
# terminal 1 — backend
cd server && npm run dev      # tsx watch, http://localhost:5000

# terminal 2 — frontend
cd client && npm run dev      # Vite, http://localhost:5173

# terminal 3 — background worker (Phase 7). Optional for most work — only
# needed to actually process queued jobs (the daily integrity check, the
# outbox drain, webhook delivery). The API server runs fine without it.
cd server && npm run worker
```

Verify:

```bash
curl http://localhost:5000/api/v1/health
```

A healthy response is `200` with `"status":"ok"`, `db.connected: true`, and `redis.connected: true`. If PostgreSQL is unreachable the endpoint answers **503** with `"status":"degraded"` — deliberately, so a probe cannot report healthy while the primary datastore is down. Redis being unreachable does **not** 503 — every read endpoint still works; only background job processing stops — so that case is `200` with `"status":"degraded"` and an explanatory `error`.

Shut down with `Ctrl-C` in each terminal; `docker compose down` stops the containers (add `-v` to also drop the Postgres volume, which destroys all data).

## Scripts

### `server/`

| Script | Does |
|---|---|
| `npm run dev` | `tsx watch src/index.ts` — restarts on change, no build step |
| `npm run typecheck` | `tsc --noEmit`. **`tsx` does not type-check** — run this |
| `npm run build` | `tsc -p tsconfig.build.json` → `dist/`, **then copies `src/db/migrations/*.sql`** — `tsc` only emits JS, so without the copy step `dist/db/migrations/` would be empty and the built server could not migrate |
| `npm start` | Runs the built `dist/index.js` |
| `npm run migrate` | Applies pending migrations |
| `npm run db:reset` | **Destructive.** Drops schema `public` and re-runs every migration. Refuses when `NODE_ENV=production` |
| `npm run verify:integrity` | Phase 5 — standalone check that total debits equal total credits, every journal entry balances, and no ledger line is orphaned, across the whole database. Prints one line per check and exits non-zero on any failure — the script to run in front of an auditor. From Phase 7 this also runs automatically once a day via the background worker |
| `npm run worker` | Phase 7 — `tsx watch src/worker.ts`, a second process consuming the `integrity-check`, `outbox-drain`, and `webhook-deliver` queues. Requires `docker compose up -d redis` |
| `npm run worker:start` | Runs the built `dist/worker.js` |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:coverage` | Coverage over `services/`, `utils/` and `middleware/` |

### `client/`

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server on 5173, `strictPort` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Type-check, then Vite production build → `dist/` |
| `npm run preview` | Serves the built bundle |
| `npm test` | Vitest + jsdom + Testing Library, single run |
| `npm run test:watch` | Vitest watch mode |

---

## Environment variables

### Root `.env` — consumed by `docker-compose.yml` only

| Variable | Default | Notes |
|---|---|---|
| `PG_USER` | `autodb_user` | |
| `PG_PASSWORD` | `autodb_pass` | Dev only |
| `PG_DATABASE` | `autodb` | |
| `PG_PORT` | `5432` | Host-side port. Change if 5432 is taken, and mirror it in `server/.env` |
| `REDIS_PORT` | `6379` | Host-side port |

No application secrets live here.

### `server/.env`

| Variable | Required at boot | Notes |
|---|---|---|
| `NODE_ENV` | no — defaults `development` | One of `development` \| `test` \| `production` |
| `PORT` | no — defaults `5000` | |
| `FRONTEND_URL` | **yes** | CORS origin. The server throws at boot if unset |
| `PG_HOST` | no — defaults `localhost` | |
| `PG_PORT` | no — defaults `5432` | |
| `PG_USER` | **yes** | |
| `PG_PASSWORD` | **yes** | |
| `PG_DATABASE` | **yes** | |
| `ACCESS_TOKEN_SECRET` | **yes** | Access JWTs (15m). ≥32 chars |
| `REFRESH_TOKEN_SECRET` | **yes** | Refresh JWTs (7d). ≥32 chars, and **must differ** from the access secret |
| `REDIS_HOST` | no — defaults `localhost` | Phase 7 — background jobs and the webhook dispatcher |
| `REDIS_PORT` | no — defaults `6379` | |
| `REDIS_DB` | no — defaults `0` | Database index. The test suite pins itself to index 1 so `npm test` never touches your dev queues |
| `STORAGE_ROOT` | no — defaults `storage` | Phase 9.5 — the Document Vault's filesystem backend, resolved relative to `server/`'s package root. Gitignored. The test suite pins itself to `storage-test` so `npm test` never touches your dev vault |
| `ANTHROPIC_API_KEY` | no — defaults `''` | Phase 10 — AP-Flow's vision extraction, reused by Phase 16 — TaxGuard AI's cited answers. The server and worker both boot without it; `extractionService`/`answerService` throw `503` only when a real call is attempted with no key configured. Every test stubs the client, so the suite needs no key at all |
| `VOYAGE_API_KEY` | no — defaults `''` | Phase 16 — TaxGuard AI's embeddings provider (Voyage AI, called over `fetch`, no SDK). The server and worker both boot without it; corpus ingestion and question answering return `503` only when actually attempted with no key configured. Every test stubs the embeddings client |

Parsing lives in `server/src/config/env.ts`. It collects **every** problem and throws once, so a fresh checkout gets the full list rather than one variable per restart.

Generate the two secrets with two separate runs of:

```bash
openssl rand -hex 32
```

They must be different. If one key signed both token types, a stolen 7-day refresh token would verify as an access token and the short access TTL would buy nothing — so `env.ts` refuses to boot when they match.

`JWT_SECRET` is **gone** — removed from `docker-compose.yml` and `.env.example` in Phase 0. Do not reintroduce it ([guardrails.md](guardrails.md) rule 11).

### `client/.env`

| Variable | Notes |
|---|---|
| `VITE_API_BASE_URL` | `http://localhost:5000`. Must be **browser**-reachable, never a Docker service name |

Only `VITE_`-prefixed variables reach the bundle, and Vite **inlines them at build time** — they are baked into the shipped JavaScript. Nothing secret goes in this file.

---

## Docker services

| Service | Container | Host port | Healthcheck | Used by |
|---|---|---|---|---|
| PostgreSQL 16 (`pgvector/pgvector:pg16`, since Phase 16) | `autodb_postgres` | 5432 | `pg_isready` | The server |
| Redis 7 | `autodb_redis` | 6379 | `redis-cli ping` | The background worker (`npm run worker`) — BullMQ's job queues and the webhook dispatcher (Phase 7) |

**The Postgres image is `pgvector/pgvector:pg16`, not stock `postgres:16`.** It is `postgres:16` plus the `vector` extension, built `FROM postgres:16`, so the existing `postgres-data` volume is binary-compatible — no data is lost by the swap. Phase 16 (TaxGuard AI) needs `CREATE EXTENSION vector` for its RAG retrieval, and the stock image does not ship it.

**Redis was provisioned since Phase 0 and wired up in Phase 7.** `bullmq` + `ioredis`, the worker process, the healthcheck, and `REDIS_HOST`/`REDIS_PORT`/`REDIS_DB` all landed together — shared infrastructure, not owned by any one app. The API server itself does not require Redis to be up (`GET /health` reports it degraded, not down) — only `npm run worker` does.

The Postgres volume `postgres-data` survives `docker compose down`. Only `down -v` destroys it.

### Why not full Docker

The prior setup containerised all four services with source-mount hot reload. Running the two application processes on the host instead is a deliberate trade for the development phase:

- Native file watching, no `CHOKIDAR_USEPOLLING` polling overhead
- A `package.json` change is `npm install`, not `docker compose up --build <service>` to rebuild past an anonymous `node_modules` volume
- Debugger attach and stack traces point at real host paths
- Container startup is not on the edit/reload path

The cost is that Node and npm must be installed on the host, and "works on my machine" drift is possible. Containerising the server and client is deferred, not rejected — it belongs with deployment work, where a multi-stage production image is the actual requirement rather than a dev-mode image with a source mount.

The prior `entrypoint.sh` ran migrations **and the full test suite** before starting the server, aborting startup on a failing test. That behaviour has no host equivalent right now and is not simulated. Its real home is CI, which is not yet set up.

---

## Dependency policy

Do not add dependencies speculatively. **One module, one change, only its dependencies.**

Installed in Phase 0:

| Package | Layer | Why |
|---|---|---|
| `express` 5 | server | HTTP. v5 forwards rejected promises from async handlers to the error middleware, so no `asyncHandler` wrapper is needed |
| `cors` | server | Single configured origin with credentials |
| `pg` | server | Raw driver. **No ORM** |
| `dotenv` | server | Loads `server/.env` uniformly in dev, test, and prod |
| `tsx` | server (dev) | esbuild-based TS execution + watch |
| `typescript` 7 | both (dev) | Type-checking only; never on the runtime path |
| `vitest`, `supertest` | server (dev) | Test runner + HTTP assertions |
| `react`, `react-dom` 19 | client | |
| `vite` 8, `@vitejs/plugin-react` | client (dev) | Dev server + production bundler |

Added in Phase 1:

| Package | Layer | Why |
|---|---|---|
| `jsonwebtoken` | server | Access + refresh JWTs |
| `bcrypt` | server | Password hashing. The native build hashes on the libuv threadpool, so it does not block the event loop the way pure-JS `bcryptjs` does |
| `cookie-parser` | server | Reads the httpOnly auth cookies. Unsigned — the JWTs carry their own signature |
| `react-router-dom` 7 | client | Routing, arriving with the second page as planned |
| `vitest`, `jsdom`, `@testing-library/*` | client (dev) | The client had no test runner before Phase 1 |

Deliberately **not** installed in Phase 1: `zod`. Phase 1's request bodies are flat objects of five scalars, which a hand-rolled `utils/validate.ts` covers clearly (and it is unit-tested, because it is security-relevant). The **revisit trigger** recorded here was LedgerCore's journal entries, whose nested `lines[]` array is where hand-rolling stops paying — see Phase 3 below, where it fired.

Nothing new in Phase 2 — the app registry is a static in-code list (`config/apps.ts`), not a request body, so it needs no validation library and no migration.

Added in Phase 3:

| Package | Layer | Why |
|---|---|---|
| `zod` | server | The revisit trigger above, fired. `POST /journals` takes a nested array of line objects with cross-field rules; `z.infer` also makes the schema and the TypeScript type one artifact instead of two that drift. Existing Phase 1 routes keep `utils/validate.ts` — this is an addition, not a rewrite |
| `express-rate-limit` | server | Throttling `/auth/login` and `/auth/register`. Scheduled for this phase since Phase 1, where it was deferred deliberately rather than overlooked |
| `tailwindcss` 4 + `@tailwindcss/vite` | client | LedgerCore is the first app with dense UI — a trial-balance grid, a multi-line entry form. v4 configures in CSS (`@import "tailwindcss"`), so there is no `tailwind.config.js`. The existing `index.css` keeps the auth and chooser pages working; new pages are Tailwind-first |
| `lucide-react` | client | Icon set. Tree-shakes per icon, so unused ones do not ship |

Nothing new in Phase 4 or Phase 5. Phase 5's request-context propagation uses `node:async_hooks`' `AsyncLocalStorage`, part of the Node runtime — no dependency to add.

Added in Phase 7:

| Package | Layer | Why |
|---|---|---|
| `bullmq` | server | Background job queues, workers, retry/backoff, and the repeatable-job scheduler behind the daily integrity check and the 5-second outbox drain |
| `ioredis` | server | The Redis client BullMQ itself needs a connection factory for; also backs the `GET /health` Redis ping |

No client-side dependency this phase — `WebhooksPage`/`WebhookDeliveriesPage` are built entirely from `lucide-react` (already present since Phase 3) and hand-rolled components, the same as every other LedgerCore page.

Added in Phase 9.5:

| Package | Layer | Why |
|---|---|---|
| `multer` | server | The Document Vault's multipart upload (`POST /documents`). **Moved from Phase 10 on 2026-09-10** when document storage was promoted out of AP-Flow to platform infrastructure — see [roadmap.md](roadmap.md#phase-renumbering--2026-09-10). Scoped to `middleware/upload.ts`, mounted on the one upload route only — never registered globally beside `express.json` |
| `@types/multer` | server, dev | Multer 2.x ships no types of its own |

No client-side dependency this phase either — `DocumentsPage`/`AttachmentsPanel` use `FormData`/`Blob`/`URL.createObjectURL`, all browser built-ins.

**`file-type` was considered and refused.** The Document Vault must decide a MIME type from magic bytes rather than the client's `Content-Type` header, but that is a small parser, so `utils/mimeSniff.ts` is hand-written instead — the same call made for `utils/csv.ts`, `utils/levenshtein.ts` and `utils/dateParse.ts`.

Added in Phase 10:

| Package | Layer | Why |
|---|---|---|
| `tesseract.js` | server | AP-Flow's **local** OCR with bounding boxes. Local is the point — PII is located and masked before any image leaves the machine. Downloads `eng.traineddata` (~15MB) into `server/.tesseract/` on first real use; every test injects a fake `OcrAdapter` instead, so `npm test` never triggers the download |
| `sharp` | server | Rasterizing and masking image buffers for the redaction pipeline (a native binding to libvips) |
| `pdfjs-dist` | server | Rendering PDF pages to images before OCR. `@napi-rs/canvas` appears in `package-lock.json` as this package's own transitive `optionalDependency` — its Node canvas factory, lazily loaded, never imported directly here and never added to `dependencies` |
| `@anthropic-ai/sdk` | server | AP-Flow's vision extraction of already-redacted documents, forced into a `record_invoice` tool call rather than free-form JSON. Needs `ANTHROPIC_API_KEY` in `server/.env`; every test injects a stub `VisionClient` and stubs `fetch` to throw, so the suite needs no key and makes no network call |

No client-side dependency this phase — `ApFlowDocumentsPage`/`ApFlowDocumentDetailPage` are hand-rolled components, matching every other LedgerCore/AP-Flow page.

Added in Phase 15:

| Package | Layer | Why |
|---|---|---|
| `pptxgenjs` | server | BoardDeck Automator's `.pptx` deck generation, run in the worker process. Its own `.d.ts` (v4.0.1) declares a `declare class` + `declare namespace` merge that a `moduleResolution: "Bundler"` project resolves cleanly, but under this project's required `"module": "NodeNext"` (the only mode matching how Node actually resolves ESM at runtime) combined with TypeScript 7.0.2, the default-import binding resolves to the whole file's own top-level exports instead of the merged class+namespace type — verified independently against `moduleResolution: "Bundler"`, where the identical import typechecks cleanly. `services/boarddeck/deckBuilderService.ts` works around it with a narrow, hand-written interface for the exact API surface used (`addSlide`/`addText`/`addTable`/`write`) and one explicit type assertion, rather than `any`, `@ts-ignore`, or loosening the project's tsconfig |

No client-side dependency this phase — `BoardDeckCloseRunsPage`/`BoardDeckBvaPage`/`BoardDeckDecksPage` are hand-rolled components, matching every other app's pages.

Added in Phase 16 — **zero new npm packages**, two infrastructure changes instead:

| Change | Layer | Why |
|---|---|---|
| `docker-compose.yml`'s `postgres` image → `pgvector/pgvector:pg16` | infrastructure | TaxGuard AI's RAG retrieval needs `CREATE EXTENSION vector`; the stock `postgres:16` image does not ship it. The pgvector image is `postgres:16` plus the extension, built `FROM postgres:16`, so the existing `postgres-data` volume is binary-compatible |
| Voyage AI embeddings via the platform's built-in `fetch` | server | Anthropic ships no embeddings endpoint; Voyage is its own documented recommendation. Called over `fetch` rather than an installed SDK — `services/taxguard/embeddingService.ts` exports an injectable `EmbeddingsClient` seam exactly as `extractionService.ts`'s `VisionClient` does, so no test reaches the network and adding an SDK later (if ever) touches only this one file |
| `@anthropic-ai/sdk` (already installed, Phase 10) reused for `services/taxguard/answerService.ts` | server | The same forced-tool-call pattern AP-Flow's vision extraction established, this time for cited answers. No new dependency |
| `pdfjs-dist` (already installed, Phase 10) reused for `queue/handlers/taxguardEmbedHandler.ts`'s text extraction | server | `getTextContent()` rather than the rasterize-to-canvas path AP-Flow uses. No new dependency |

No client-side dependency this phase — `TaxGuardCorpusPage`/`TaxGuardCorpusDetailPage`/`TaxGuardAskPage` are hand-rolled components, matching every other app's pages.

Approved for later phases, add only when the app that needs it is being built:

| Dependency | For | Phase |
|---|---|---|
| ~~`csv-parse`~~ | LedgerCore's bank statement ingestion. **Approved but never installed** — Phase 6 hand-wrote `utils/csv.ts` (a two-pass state machine) instead, and the row is kept struck through rather than deleted so the reversal stays visible | ~~6~~ |
| ~~`pptxgenjs` or similar~~ | BoardDeck Automator's `.pptx` generation. **Installed in Phase 15** — see the Phase 15 table above | ~~15~~ |
| `intuit-oauth` or hand-rolled `fetch` | LedgerCore's QuickBooks Online OAuth 2.0 flow | 17 |
| ~~`pgvector` (PG extension)~~ | TaxGuard AI's RAG retrieval. **Delivered in Phase 16** — the compose image swap above, not a package | ~~16~~ |
| ~~An embeddings SDK~~ | TaxGuard AI's RAG. **Resolved in Phase 16 without one** — Voyage AI over plain `fetch`, see the Phase 16 table above | ~~16~~ |

**Phase 9.5 also added a directory, not just a package.** The Document Vault stores uploads under `server/storage/`, which is gitignored (`server/storage-test/` too, for the test suite). Files are named by SHA-256 but the path is keyed by organization first — `server/storage/<org_id>/<ab>/<cd>/<sha256>` — so two tenants uploading identical bytes get two blobs. Global content addressing was rejected: it would let one tenant detect that another holds the same file, and it would make deleting a blob unsafe whenever two organizations shared it. It is deliberately the simplest thing that satisfies the audit requirement and does not survive a multi-instance deployment; `services/storageService.ts` keeps a narrow `put`/`get`/`stat` interface so object storage is a one-file swap later. This was Phase 10's, AP-Flow-owned, until 2026-09-10 — see [roadmap.md](roadmap.md#phase-renumbering--2026-09-10).

**`STORAGE_ROOT`** (optional, defaults to `storage`, resolved relative to `server/`'s package root) is the env var controlling where that directory lives — see the environment table below.

**Phase 10 added a directory too.** `tesseract.js` caches its downloaded language data under `server/.tesseract/` (`TESSERACT_CACHE_DIR` in `config/constants.ts`), gitignored, separate from `server/storage/` — tenant document bytes and a language model are different kinds of thing and don't share a directory.

**No ORM.** Financial correctness depends on knowing exactly what SQL runs — `SELECT ... FOR UPDATE` locks, recursive CTEs, `EXCLUDE USING GIST` constraints, and explicit transaction boundaries are all first-class here. Raw `pg` with parameterized queries and hand-written migrations stays.

---

## Troubleshooting

**Server exits immediately with "Invalid server environment"** — `server/.env` is missing or incomplete. The message lists every missing variable.

**Health returns 503, `db.error: connect ECONNREFUSED`** — Postgres is not up. `docker compose up -d postgres`, then `docker exec autodb_postgres pg_isready -U autodb_user -d autodb`.

**Port 5432 or 6379 already allocated** — another project's container owns it. Change `PG_PORT` / `REDIS_PORT` in the root `.env`, and mirror `PG_PORT` in `server/.env`.

**Vite exits with a port error** — `strictPort` is on, so it refuses to drift to 5174. That is intentional: the server's CORS origin is pinned to 5173, and a silent port shift produces confusing CORS failures instead of an immediate one.

**Browser console shows a CORS error** — `FRONTEND_URL` in `server/.env` must exactly match the origin serving the page, scheme and port included.

**Type errors do not appear when running `npm run dev`** — correct. `tsx` strips types without checking them. Run `npm run typecheck`.

**Server exits with "ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different"** — exactly what it says. Generate two independent values with `openssl rand -hex 32`.

**Migration fails with "column … does not exist" on a fresh checkout** — the Docker volume outlives the code. `docker compose down` does *not* delete `postgres-data`, so a database can still hold tables from an older schema; `CREATE TABLE IF NOT EXISTS` then silently no-ops against the stale table and the next statement fails. This actually happened when Phase 1 landed: the volume still carried the pre-2026-07-30 build's `users`, `accounts` and `refresh_tokens`. Fix with `npm run db:reset`, or `docker compose down -v` to drop the volume outright. Both are destructive — back up first with `docker exec autodb_postgres pg_dump -U autodb_user -d autodb > backup.sql`.

**Every authenticated request 401s, with no CORS error to explain it** — check that `VITE_API_BASE_URL` and the page origin both use `localhost`, not a mix of `localhost` and `127.0.0.1`. Same-site is computed from the registrable domain, and IP literals are not in the Public Suffix List, so each is its own site: `localhost:5173` → `127.0.0.1:5000` is genuinely cross-site and the browser silently withholds every `SameSite=Lax` cookie. Ports are irrelevant to this — `localhost:5173` → `localhost:5000` is same-site and works.

**Integration tests fail with `database "autodb_test" does not exist`** — normally self-healing: `globalSetup` creates it. If it persists, Postgres is not reachable at all. The suite deliberately uses a **separate** database so its `TRUNCATE` between tests can never touch your dev data.

**`npm test` fails with "Could not reach Redis for the queue tests"** — `docker compose up -d redis` is now a prerequisite for the full suite (Phase 7). The integration tests flush Redis database index **1**, never index 0, so your dev queues are never touched.

**Worker throws `MaxRetriesPerRequestError` and exits** — this means a Redis connection was created without `maxRetriesPerRequest: null`, which every connection in `queue/connection.ts` sets deliberately: BullMQ's blocking commands (`BRPOPLPUSH` and similar) legitimately wait far longer than ioredis's default retry budget allows. If you see this from code that constructs its own `Redis`/`Queue`/`Worker` instance rather than going through `createRedisConnection()`, that is the bug — route it through the shared factory instead.
