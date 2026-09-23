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
./dev.sh
```

One command, run from the repository root, no arguments. In order: brings up `postgres` + `redis` and waits for their compose healthchecks, applies pending migrations, then runs the server (`:5000`), the background worker, and the client (`:5173`) as three prefixed processes. One Ctrl-C stops all three. It starts `postgres` and `redis` only, **not** `postgres-test` — running the test suite still needs `docker compose up -d postgres-test redis` separately.

**The per-terminal path still works, and is still the right tool** when you want to restart one process alone, attach a debugger to just the server, or read one process's output without the other two interleaved:

```bash
docker compose up -d          # postgres :5432, postgres-test :5433, redis :6379
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

### Root

| Script | Does |
|---|---|
| `./dev.sh` | The full stack in one command; see [§ Every session](#every-session) |

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
| `npm run seed:demo` | Phase 18 — seeds the 24-month sandbox dataset into the single organization in the database (or the one named by an argument: `npm run seed:demo -- "Acme Inc"`). Refuses when `NODE_ENV=production`, mirroring `db:reset`. Also reachable as `POST /api/v1/sandbox/load` |
| `npm run walkthrough` | Phase 6.1 — (re)generates `walkthrough/` at the repo root: a three-month, hand-enterable accounting scenario plus a computed answer key. Writes no data to any database. `--anchor YYYY-MM` fixes the scenario's first month (default: three months back from today); the committed copy was generated with `--anchor 2026-06`. The folder is generated output — edit `server/src/scripts/walkthroughDataset.ts` and re-run, never hand-edit a file under `walkthrough/` |
| `npm run worker` | Phase 7 — `tsx watch src/worker.ts`, a second process consuming the `integrity-check`, `outbox-drain`, and `webhook-deliver` queues. Requires `docker compose up -d redis` |
| `npm run worker:start` | Runs the built `dist/worker.js` |
| `npm test` | Vitest, single run (~3.3 min, 126 files in parallel). Requires `docker compose up -d postgres-test redis` — the **test** cluster on :5433, not the dev one |
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
| `REDIS_DB` | no — defaults `0` | Database index. Each test worker pins itself to its own index (1..3, never 0) so `npm test` never touches your dev queues |
| `STORAGE_ROOT` | no — defaults `storage` | Phase 9.5 — the Document Vault's filesystem backend, resolved relative to `server/`'s package root. Gitignored. Each test worker pins itself to its own `storage-test-<n>` so `npm test` never touches your dev vault |
| `ANTHROPIC_API_KEY` | no — defaults `''` | Phase 10 — AP-Flow's vision extraction, reused by Phase 16 — TaxGuard AI's cited answers. The server and worker both boot without it; `extractionService`/`answerService` throw `503` only when a real call is attempted with no key configured. Every test stubs the client, so the suite needs no key at all |
| `AP_FLOW_AI_PROVIDER` | no — defaults `anthropic` | Phase 19 — which of `anthropic` \| `gemini` AP-Flow's extraction and classification use. Only the selected provider's key needs to be set |
| `GEMINI_API_KEY` | no — defaults `''` | Phase 19 — AP-Flow's second extraction provider, called over `fetch` (no SDK — rule 14). Needed only when `AP_FLOW_AI_PROVIDER=gemini` or `TAXGUARD_EMBEDDING_PROVIDER=gemini`. Note: on Google's free tier, prompt content may be used to improve Google's products — AP-Flow only ever sends already-redacted pages, but confirm which tier your key is on |
| `AP_FLOW_GEMINI_MODEL` | no — defaults `gemini-3.6-flash` | Phase 19. Pinned deliberately, not the floating `gemini-flash-latest` alias — a model must not change under a live ledger without a diff. Retiring one is expected maintenance: the original default, `gemini-2.5-flash`, started returning `404` ("no longer available to new users") on 2026-09-14 even though it still appeared in Google's `ListModels`; only `generateContent` had actually stopped serving it |
| `TAXGUARD_EMBEDDING_PROVIDER` | no — defaults `voyage` | 2026-09-22 — `voyage` \| `gemini`. Which provider embeds TaxGuard chunks and questions. `gemini` uses `GEMINI_API_KEY` (`gemini-embedding-001`, 1024 dims; its free tier works, and embeds a 50-page act in under a minute). Only the selected provider's key is needed. Vectors from different providers are not comparable: after switching, delete and re-add every TaxGuard corpus document |
| `VOYAGE_API_KEY` | no — defaults `''` | Phase 16 — TaxGuard AI's embeddings provider (Voyage AI, called over `fetch`, no SDK). The server and worker both boot without it; corpus ingestion and question answering return `503` only when actually attempted with no key configured. Every test stubs the embeddings client |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | no — both default `''` | Phase 19.3 — the Drive integration's **recommended** connection mode: no consent screen, no Google app verification, no refresh-token expiry (RFC 7523's JWT-bearer grant). The server and worker both boot without them; `driveConnectionService.connectServiceAccount` returns `503` only when actually attempted with either unset. The private key must be a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`, the format Google's downloaded JSON key uses) with its `\n` escapes intact — the server unescapes them at load time. Never written to a table, never logged |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | no — both default `''` | Phase 19.2 — the Drive integration's secondary connection mode, a Web application OAuth client from Google Cloud Console. Retained for a tenant whose Workspace admin blocks sharing to an external service-account address. The server and worker both boot without them; `driveConnectionService` returns `503` only when a real Drive action is attempted with either unset |
| `GOOGLE_OAUTH_REDIRECT_URI` | no — defaults `http://localhost:5000/api/v1/integrations/drive/oauth/callback` | Phase 19.2, path **changed in 19.3** when the route moved off `/api/v1/ap-flow/drive`. Must exactly match an authorized redirect URI on the Google Cloud OAuth client. A `.env` still pinning the pre-19.3 path keeps working — `/api/v1/ap-flow/drive/oauth/callback` is kept as a one-route legacy alias — but update it when convenient; the alias is removed once nothing depends on it |
| `INTEGRATION_ENCRYPTION_KEY` | no — defaults `''` | Phase 19.2 — AES-256-GCM key (`utils/secretBox.ts`) for the OAuth path's refresh tokens and PKCE verifiers at rest. Not needed for the service-account path, which stores no per-tenant secret. When set, must be 64 hex characters (32 bytes) or the server refuses to boot — the same fail-loud posture `ACCESS_TOKEN_SECRET`'s length check takes. Not a JWT secret (rule 11) — a separate concern, never reused |

Parsing lives in `server/src/config/env.ts`. It collects **every** problem and throws once, so a fresh checkout gets the full list rather than one variable per restart.

Generate the two secrets with two separate runs of:

```bash
openssl rand -hex 32
```

They must be different. If one key signed both token types, a stolen 7-day refresh token would verify as an access token and the short access TTL would buy nothing — so `env.ts` refuses to boot when they match.

`JWT_SECRET` is **gone** — removed from `docker-compose.yml` and `.env.example` in Phase 0. Do not reintroduce it ([guardrails.md](guardrails.md) rule 11).

### Setting up Drive intake

The recommended path needs a one-time Google Cloud setup, done once per deployment (or once for local dev), not per tenant:

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/) (or reuse an existing one) and enable the **Google Drive API**.
2. **IAM & Admin → Service Accounts → Create service account.** Any name; no roles need granting on the project itself — the account's only job is to be shared into tenants' own Drive folders.
3. Open the new service account → **Keys → Add key → Create new key → JSON**, and download it.
4. From that JSON file, copy `client_email` into `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `private_key` into `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` — paste it exactly as the JSON has it, `\n` escapes and all; the server unescapes them at load time, so do not manually insert real newlines.
5. Restart the server. `GET /api/v1/integrations/drive` now reports `modes.serviceAccount: true` and returns the address to share with.
6. In the app: **Integrations** → copy the service-account address → share a Drive folder with it (Viewer) → paste the folder's link and choose what it's for.

The OAuth path (secondary, for a Workspace tenant that blocks external sharing) instead needs a Web application OAuth client: **APIs & Services → Credentials → Create Credentials → OAuth client ID**, authorized redirect URI `http://localhost:5000/api/v1/integrations/drive/oauth/callback` (or your deployed origin), then `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` plus a generated `INTEGRATION_ENCRYPTION_KEY` (`openssl rand -hex 32`).

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
| PostgreSQL 16, same image, `fsync=off` | `autodb_postgres_test` | 5433 | `pg_isready` | **The test suite only.** Durability is off because `TRUNCATE` fsyncs a file per table and index: 2055 ms vs 69 ms. `fsync` is cluster-wide, hence a second container rather than a flag on the first — see [testing.md](testing.md) |
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

**Phase 19 added no dependency, server or client.** AP-Flow's second extraction provider (Gemini) is called over the built-in `fetch`, exactly like TaxGuard AI's Voyage embeddings client — no `@google/genai` or `googleapis` SDK. The multi-provider seam (`services/ap-flow/modelClient.ts`), the bill-posting rewrite, the auto-post gate, and the direct-upload route all reuse `@anthropic-ai/sdk`, `multer`, `zod` and hand-written utilities already in the tree.

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

**Phase 19.1 (AI token/cost metering) added no dependency, server or client.** Token usage is read straight off the provider responses `modelClient.ts` already parses (`usage`/`usageMetadata`); cost arithmetic is hand-written exact `BigInt` math in `utils/microUsd.ts`, the same call `utils/money.ts` made for ledger cents. Per-model pricing lives in `config/aiPricing.ts` as a plain object keyed by model id, versioned by `AI_PRICING_VERSION` — add a model's price only from the provider's own published pricing page, and bump the version alongside it. A model absent from that table is not an error: its calls are recorded with real tokens and `cost_micro_usd NULL`, surfaced to the reader as `unpricedCallCount` rather than folded into a total that would then understate real spend.

**Phase 19.2 (Google Drive folder intake) added no dependency either.** No `googleapis` — OAuth 2.0 + PKCE and the Drive v3 REST surface are hand-rolled over the built-in `fetch` in `services/integrations/googleDriveClient.ts` (moved from `services/ap-flow/` in Phase 19.3), the identical no-SDK call `modelClient.ts`'s Gemini adapter and `embeddingService.ts`'s Voyage adapter already made. AES-256-GCM (`utils/secretBox.ts`) and SHA-256/PKCE (`utils/pkce.ts`) both come from Node's built-in `node:crypto`, the same module `utils/webhookSignature.ts` already uses.

**Phase 19.3 (service-account auth) added no dependency either.** RFC 7523's JWT-bearer grant needs only an RS256 signature over a JSON payload — `node:crypto`'s `createSign`, no `google-auth-library`. See [study/security-auth/service-accounts-and-jwt-bearer.md](../study/security-auth/service-accounts-and-jwt-bearer.md).

Added in Phase 28:

| Package | Layer | Why |
|---|---|---|
| `qrcode` | server | StockLedger's label generation (`services/stock/labelService.ts`) — renders a QR payload to SVG server-side, so the physical label size and print scaling stay lossless and the payload-construction logic (the frontend base URL) never has to ship to the client. `@types/qrcode` alongside it, dev-only |

No client-side dependency this phase — every StockLedger page (`StockSetupPage`, `StockItemsPage`, `StockMovementPage`, `StockLabelsPage`, `AttributeFields`, and the rest) is hand-rolled, matching every other app's pages; the generated QR SVG reaches the client as a string and is rendered as an `<img src="data:image/svg+xml;base64,...">`, never `dangerouslySetInnerHTML`.

---

## Troubleshooting

**`./dev.sh` exits with "port 5000 is already in use"** — an earlier run was orphaned, or a `npm run dev` is still up in another terminal. `pgrep -af 'tsx watch'`, then kill the process group (`kill -TERM -<pid>`), not the pid alone — see the study note on why signalling `npm` leaves children behind.

**One process dies and `./dev.sh` takes the other two down** — deliberate. `wait -n` returns on the first child to exit and the launcher tears the rest down and exits 1, because a half-running stack (a server with no worker draining its queues) fails in ways that look like application bugs. The exiting process's own `[label]` lines above the shutdown message say why.

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

**A queue you renamed or removed still seems to be firing** — a BullMQ repeatable job scheduler lives in Redis, keyed by an id the code chose, not by the queue name in your current source. Renaming or deleting the queue in TypeScript does nothing to a scheduler already sitting in Redis under its old id; it keeps firing forever, enqueueing onto a queue nothing now consumes. `startWorkers()` should call `removeJobScheduler('<old-scheduler-id>')` once for any renamed queue (Phase 19.3 does this for `ap-flow-drive-sweep-tick`, the id 19.2's scheduler used before the rename to `integration-drive-sweep`). To confirm one is still ticking: `docker exec -it <redis-container> redis-cli KEYS 'bull:<old-queue-name>:*'` should return nothing once cleaned up.
