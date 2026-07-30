# Development — Running the Stack

Neither path below works until Phase 0 creates `server/` and `client/`.

## Option A — Full Docker (recommended)

```bash
# from project root
cp .env.example .env          # set real secrets; dev defaults apply if absent
docker compose up --build     # postgres, redis, server, client
```

`entrypoint.sh` runs on server start: wait for PostgreSQL → run migrations → **run the test suite** → start the dev server. A failing test aborts startup — this is intentional, keep it.

```bash
docker compose up --build server   # rebuild server only, after dependency changes
docker compose up --build client   # rebuild client only
```

## Option B — Local (no Docker)

Requires PostgreSQL 16 running locally.

```bash
# terminal 1 — backend
cd server
cp ../.env.example .env   # set PG_HOST=localhost, PG_PORT, PG_USER, PG_PASSWORD,
                          # PG_DATABASE, PORT, FRONTEND_URL and the JWT secrets
npm install
npm run migrate
npm run dev

# terminal 2 — frontend
cd client
npm install
npm run dev               # Vite on 5173
```

`npm run db:reset` drops and recreates the dev schema. **Destructive** — never run it against anything but a local dev database.

**URLs:** frontend `http://localhost:5173`, API `http://localhost:5000/api/v1`.

---

## Environment variables

Root `.env.example` holds secrets only; `PG_*` and `PORT` are supplied by `docker-compose.yml` for the containerized path and must be set manually for local runs.

| Variable | Used by | Notes |
|---|---|---|
| `PORT` | server | `5000`; container maps `5000:5000` |
| `FRONTEND_URL` | server | CORS allowed origin. **Server must exit at boot if unset** |
| `ACCESS_TOKEN_SECRET` | server | Signs + verifies access JWTs (15m) |
| `REFRESH_TOKEN_SECRET` | server | Signs + verifies refresh JWTs (7d) |
| `PG_HOST` | server | `postgres` in Docker, `localhost` locally |
| `PG_PORT` | server | 5432 |
| `PG_USER` | server | `autodb_user` |
| `PG_PASSWORD` | server | `autodb_pass` |
| `PG_DATABASE` | server | `autodb` |
| `NODE_ENV` | server | `development` \| `production`. Controls the `secure` cookie flag |
| `VITE_API_BASE_URL` | client | `http://localhost:5000` — must be **browser**-reachable, never a Docker service name |

`JWT_SECRET` is **removed**. It is still present in `docker-compose.yml` and `.env.example` from the prior build — delete it in Phase 0.

Planned additions, do not add early: `REDIS_HOST`/`REDIS_PORT` (Phase 5), `S3_*` (Phase 14), FX provider key (Phase 13).

---

## Docker services

| Service | Container | Host | Internal | Hot reload |
|---|---|---|---|---|
| PostgreSQL 16 | `autodb_postgres` | 5432 | 5432 | n/a |
| Redis 7 | `autodb_redis` | 6379 | 6379 | n/a (unused until Phase 5) |
| Express server | `autodb_server` | 5000 | 5000 | nodemon watches `src/` |
| Vite client | `autodb_client` | 5173 | 5173 | Vite HMR via volume mount |

The server waits on PostgreSQL's `pg_isready` healthcheck before starting. Redis has no healthcheck and no `depends_on` — add both in Phase 5.

Source volumes give hot reload without image rebuilds:
- `./server/src` → `/app/src`
- `./client/src` → `/app/src`
- anonymous `/app/node_modules` volumes prevent host `node_modules` from shadowing container-installed packages

Because `node_modules` is an anonymous volume, **a `package.json` change requires `docker compose up --build <service>`** — a plain restart will not install the new dependency.

---

## Dependency policy

Do not add dependencies speculatively. **One module, one PR, only its dependencies.**

Approved for later phases, add only when the module that needs it is being built:

| Dependency | For | Phase |
|---|---|---|
| `bullmq` + `ioredis` | background workers (payroll batches, PDF rendering, FX polling, depreciation cron) | 5 |
| `ajv` | JSON Schema validation for QMS dynamic `JSONB` forms | 12 |
| `pg_trgm` (PG extension) | CRM fuzzy search | 12 |
| `btree_gist` (PG extension) | leave-overlap `EXCLUDE` constraints | 11 |
| S3-compatible SDK | presigned uploads | 14 |
| Tesseract or AWS Textract | OCR | 14 |

**No ORM.** Financial correctness depends on knowing exactly what SQL runs — `SELECT ... FOR UPDATE` locks, `WITH RECURSIVE` BOM resolution, `EXCLUDE USING GIST` constraints, and explicit transaction boundaries are all first-class here. Raw `pg` with parameterized queries and hand-written migrations stays.

**Redis is provisioned but must not be claimed.** The compose file runs a Redis 7 container. Until Phase 5 installs `bullmq` + `ioredis` and wires a worker process, nothing connects to it.
