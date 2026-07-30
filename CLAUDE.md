# AutoLedger ERP — CLAUDE.md

Multi-tenant Enterprise ERP suite. PostgreSQL + Express/TypeScript + React. Double-entry accounting is the system of record; every module posts journal entries into the General Ledger.

## State: empty repo, nothing built

On 2026-07-30 the previous single-user bookkeeping build (`server/`, `client/`, ~65 files) was **deleted deliberately** for a from-scratch rebuild. There is no legacy code to preserve, extend, or migrate. Do not reference old files by path — they do not exist, and this was never a git repo, so there is no history to recover.

What exists: `docker-compose.yml`, `.env.example`, `.gitignore`, `README.md` (stale), `docs/`, `Flowchart/`. No `server/`, no `client/`, no migrations, no tests.

**Nothing in `docs/` is BUILT.** It is all target state. Check the filesystem before claiming any capability exists. Next step is Phase 0 (scaffold) — see [docs/roadmap.md](docs/roadmap.md).

## Hard rules

Violating any of these is a bug, not a style choice. Full detail and code examples: [docs/guardrails.md](docs/guardrails.md).

1. **Every query is scoped by `org_id`.** No `org_id` predicate = tenant data leak. `user_id` is a `created_by` audit field, **never** an access check. Read the active org only from the verified access token — never a header, param, or body.
2. **No SQL in controllers.** Controllers validate input, call a service, format the response. All `pool.query` / `client.query` lives in `src/services/` — including auth.
3. **Money is integer `BIGINT` cents.** Never floats, never `DECIMAL`. `isBalanced` is integer equality, never an epsilon comparison.
4. **Parameterized queries only** (`$1, $2`). Never interpolate into SQL — whitelist identifiers like sort columns against a constant map.
5. **Inside a transaction, every query uses the checked-out `client`.** A stray `pool.query` silently escapes the transaction. No post-`COMMIT` follow-up work — queue it.
6. **Posted financial documents are immutable.** Correct via reversing entries (`POST /:id/reverse`). No `PUT`/`DELETE` on a posted journal, invoice, receipt, or payroll run.
7. **A ledger line has exactly one side populated.** Both sides > 0 is invalid; both zero is invalid. Enforce in the service *and* with a CHECK constraint.
8. **Every `*_id` gets a `REFERENCES` constraint** with explicit `ON DELETE`. Index every FK used in a join and every scope column.
9. **Emails lowercase on write**, backed by `UNIQUE (LOWER(email))`.
10. **Lifecycle status lives in one FSM transition table** in code. No ad-hoc status assignment scattered across services.
11. **Tokens:** `ACCESS_TOKEN_SECRET` (15m) and `REFRESH_TOKEN_SECRET` (7d). There is no `JWT_SECRET` — do not reintroduce it. Never log decoded payloads.
12. **Account types are exactly five:** `Asset`, `Liability`, `Equity`, `Revenue`, `Expense`. Never a sixth.
13. **Migrations:** `server/src/db/migrations/` only, sequential 3-digit prefix, additive and idempotent. **Never edit an applied migration.** Destructive changes need explicit sign-off.
14. **No dependency before the phase that needs it.** No ORM. Redis runs but nothing connects to it until Phase 5 — don't claim queueing works.
15. **Every module ships tests**, including a cross-tenant isolation test. Without one it is not done.

## Docs

Read the relevant file before working — they are not in context by default.

| File | Read it when |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | Starting any work — phase order, gates, and each module's intended DB pattern |
| [docs/guardrails.md](docs/guardrails.md) | Writing any server code; also holds why the old build was scrapped |
| [docs/architecture.md](docs/architecture.md) | Touching auth, tenancy, or RBAC; adding files (layer-first layout, module delivery order) |
| [docs/schema.md](docs/schema.md) | Writing a migration or a query — table definitions, constraints, default chart of accounts |
| [docs/api.md](docs/api.md) | Adding or changing a route — response shape, pagination, error conventions |
| [docs/development.md](docs/development.md) | Running the stack, env vars, Docker, adding a dependency |
| [docs/testing.md](docs/testing.md) | Writing tests — unit vs integration tiers and what each must cover |

## Keeping docs honest

The prior build's docs drifted from reality and the drift hid a structural problem until a rewrite was cheaper than a repair. When a change lands, update the affected doc in the same pass — `docs/api.md` for routes, `docs/schema.md` for tables, `docs/roadmap.md` for phase status. Claiming something works when it doesn't is worse than saying nothing.
