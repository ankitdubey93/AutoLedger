# AutoLedger

Multi-tenant Enterprise ERP suite. PostgreSQL + Express/TypeScript + React.

Double-entry accounting is the system of record: every module — inventory, procurement, sales, payroll — posts journal entries into the General Ledger rather than keeping its own private notion of money. All amounts are integer `BIGINT` cents; all business data is scoped to an `organization`.

## Status — Phase 0 complete (scaffold)

The stack boots and the three tiers are connected. **No business functionality exists yet.**

| Built | Not built |
|---|---|
| Express + TypeScript server, strict compiler config | Auth, tenancy, RBAC (Phase 1) |
| PostgreSQL connection pool | Migrations, any table at all (Phase 1) |
| `GET /api/v1/health` — live DB round trip | The General Ledger (Phase 2) |
| Error handling + graceful shutdown | Everything in [docs/roadmap.md](docs/roadmap.md) phases 1–15 |
| React + Vite client showing API status | |
| Vitest, 4 tests passing | |

Redis runs in Docker but **nothing connects to it** until Phase 5.

Nothing under `docs/` describes working code unless this table says so — it is target-state design. See [docs/roadmap.md](docs/roadmap.md).

## Running it

PostgreSQL and Redis run in Docker. The server and client run on the host, each in its own terminal.

Requires Node 22+ and Docker.

```bash
# once
cp .env.example .env                  # docker-compose credentials
cp server/.env.example server/.env
cp client/.env.example client/.env
(cd server && npm install)
(cd client && npm install)

# infrastructure
docker compose up -d                  # postgres :5432, redis :6379
```

```bash
# terminal 1
cd server && npm run dev              # http://localhost:5000

# terminal 2
cd client && npm run dev              # http://localhost:5173
```

Open http://localhost:5173 — it reports whether the API and database are reachable.

```bash
curl http://localhost:5000/api/v1/health
```

Full detail, including environment variables and the dependency policy: [docs/development.md](docs/development.md).

## Tests

```bash
cd server
npm test              # unit + integration
npm run test:coverage
```

Integration tests need the Postgres container running. Every module ships a cross-tenant isolation test from Phase 1 onward — see [docs/testing.md](docs/testing.md).

## Layout

```text
server/     Express + TypeScript API — controllers / services / routes / middleware / db
client/     React + Vite frontend
docs/       Architecture, schema, API, guardrails, roadmap
study/      Interview-prep notes generated from this project's decisions
```

## Documentation

| File | Contents |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | Phase order, gates, per-module DB patterns |
| [docs/guardrails.md](docs/guardrails.md) | The 15 non-negotiable engineering rules |
| [docs/architecture.md](docs/architecture.md) | Tenancy model, RBAC, repository layout |
| [docs/schema.md](docs/schema.md) | Table definitions and constraints |
| [docs/api.md](docs/api.md) | Route surface and response conventions |
| [docs/development.md](docs/development.md) | Running the stack, env vars, dependencies |
| [docs/testing.md](docs/testing.md) | Test tiers and what each must cover |
| [study/README.md](study/README.md) | Study-note index and coverage tracker |
