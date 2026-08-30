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
```

Verify:

```bash
curl http://localhost:5000/api/v1/health
```

A healthy response is `200` with `"status":"ok"` and `db.connected: true`. If PostgreSQL is unreachable the endpoint answers **503** with `"status":"degraded"` — deliberately, so a probe cannot report healthy while the datastore is down.

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

Parsing lives in `server/src/config/env.ts`. It collects **every** problem and throws once, so a fresh checkout gets the full list rather than one variable per restart.

Generate the two secrets with two separate runs of:

```bash
openssl rand -hex 32
```

They must be different. If one key signed both token types, a stolen 7-day refresh token would verify as an access token and the short access TTL would buy nothing — so `env.ts` refuses to boot when they match.

`JWT_SECRET` is **gone** — removed from `docker-compose.yml` and `.env.example` in Phase 0. Do not reintroduce it ([guardrails.md](guardrails.md) rule 8).

### `client/.env`

| Variable | Notes |
|---|---|
| `VITE_API_BASE_URL` | `http://localhost:5000`. Must be **browser**-reachable, never a Docker service name |

Only `VITE_`-prefixed variables reach the bundle, and Vite **inlines them at build time** — they are baked into the shipped JavaScript. Nothing secret goes in this file.

---

## Docker services

| Service | Container | Host port | Healthcheck | Used by |
|---|---|---|---|---|
| PostgreSQL 16 | `autodb_postgres` | 5432 | `pg_isready` | The server |
| Redis 7 | `autodb_redis` | 6379 | none yet | **Nothing** |

**Redis is provisioned but must not be claimed.** The container runs so the port is reserved and the topology is visible, but no code connects to it. Phase 5 adds `bullmq` + `ioredis`, a worker process, a healthcheck, and `REDIS_HOST` / `REDIS_PORT`. Until then, queueing does not work.

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

Deliberately **not** installed: `zod`. Phase 1's request bodies are flat objects of five scalars, which a ~80-line hand-rolled `utils/validate.ts` covers clearly (and it is unit-tested, because it is security-relevant). **Revisit trigger:** Phase 2's journal entries take a nested `lines[]` array, and hand-rolling nested-array validation is where a schema library starts paying for itself.

Approved for later phases, add only when the module that needs it is being built:

| Dependency | For | Phase |
|---|---|---|
| `express-rate-limit` | throttling `/auth/login` and `/auth/register`. **Currently unmitigated** — brute-forcing a password is not rate limited today. Deferred deliberately rather than overlooked | 2 |
| `bullmq` + `ioredis` | background workers (payroll batches, PDF rendering, FX polling, depreciation cron) | 5 |
| `ajv` | JSON Schema validation for QMS dynamic `JSONB` forms | 12 |
| `pg_trgm` (PG extension) | CRM fuzzy search | 12 |
| `btree_gist` (PG extension) | leave-overlap `EXCLUDE` constraints | 11 |
| S3-compatible SDK | presigned uploads | 14 |
| Tesseract or AWS Textract | OCR | 14 |

**No ORM.** Financial correctness depends on knowing exactly what SQL runs — `SELECT ... FOR UPDATE` locks, `WITH RECURSIVE` BOM resolution, `EXCLUDE USING GIST` constraints, and explicit transaction boundaries are all first-class here. Raw `pg` with parameterized queries and hand-written migrations stays.

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
