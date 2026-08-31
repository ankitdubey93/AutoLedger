# AutoLedger — CLAUDE.md

AutoLedger is a suite, not one app: a shared identity/tenancy platform hosting **seven portfolio applications**, each demonstrating a different accounting or engineering skill.

| App | Slug | Domain | Core skills |
|---|---|---|---|
| LedgerCore | `ledger-core` | Core Accounting & Systems | Double-entry integrity, DB constraints, multi-currency, QuickBooks API sync |
| TaxGuard AI | `taxguard` | Compliance & AI Workflows | RAG, vector databases, PII redaction, tax act parsing |
| AP-Flow | `ap-flow` | Operational Accounting | Multimodal OCR invoice parsing, 3-way matching, COGS tracking |
| FP&A Engine | `fpa-engine` | Financial Modeling | 3-statement linking, scenario modeling, cash runway forecasting |
| UnitEcon | `unitecon` | Commercial Analytics | Cohort retention matrices, LTV/CAC ratios, Price-Volume-Mix variance |
| BoardDeck Automator | `boarddeck` | Board Reporting & Close | Monthly close automation, BvA variance, automated `.pptx` deck generation |
| ForecasterPro | `forecaster` | Budgeting & Planning | Driver-based rolling forecasting, headcount planning, zero-based budgeting |

LedgerCore is the only app with real routes so far (`status: 'building'` in `server/src/config/apps.ts`); the other six are `'planned'` — visible on the chooser, not yet built.

## State: Phase 2 done — platform layer; no app has features yet

On 2026-07-30 the previous single-user bookkeeping build (`server/`, `client/`, ~65 files) was **deleted deliberately** for a from-scratch rebuild. There is no legacy code to preserve, extend, or migrate. Do not reference old files by path — they do not exist.

**Built:**
- **Phase 0** — `server/` (Express 5 + TS strict, `pg` Pool, error handler, fail-fast env, `GET /api/v1/health`, graceful shutdown), `client/` (React 19 + Vite 8), Postgres + Redis in Docker.
- **Phase 1** — migration runner with a checksum guard (`npm run migrate` / `db:reset`); migration 001 (`organizations`, `users`, `organization_members`, `refresh_tokens`); `authService`; `/api/v1/auth` (register, login, **POST** refresh, logout, check, switch-org) and `/api/v1/organizations` (`/`, `/members`); auth + RBAC middleware; httpOnly cookie sessions with refresh rotation and reuse detection.
- **Phase 2** — the app registry (`config/apps.ts`, `GET /api/v1/apps`); client app chooser at `/` (`AppChooserPage`), per-app shell at `/app/:appSlug` (`AppShell`), suite chrome renamed `AppLayout` → `PlatformLayout`, the old single-app dashboard moved to `/account` (`AccountPage`). No per-org entitlement yet — every org sees the same seven apps. **95 server tests + 15 client tests.**

**Not built:** no app has any real feature routes. Next step is Phase 3 (LedgerCore — GL core) — see [docs/roadmap.md](docs/roadmap.md). Phase 3 also owes the default chart of accounts **and a backfill** for orgs registered during Phases 1–2.

`server/.env` still requires `ACCESS_TOKEN_SECRET` and `REFRESH_TOKEN_SECRET` — at least 32 chars and different from each other, or the server refuses to boot.

Dev model: Postgres + Redis in Docker; server and client run from separate terminals on the host. There are no Dockerfiles and no `entrypoint.sh`.

**Assume nothing in `docs/` is built unless it is listed above.** The rest is target state — check the filesystem before claiming any capability exists.

## Hard rules

Violating any of these is a bug, not a style choice. Full detail and code examples: [docs/guardrails.md](docs/guardrails.md).

1. **Every query is scoped by `org_id`.** No `org_id` predicate = tenant data leak. `user_id` is a `created_by` audit field, **never** an access check. Read the active org only from the verified access token — never a header, param, or body. The app slug in the URL is a routing namespace, not a tenancy boundary — see rule 16.
2. **No SQL in controllers.** Controllers validate input, call a service, format the response. All `pool.query` / `client.query` lives in `src/services/` — including auth and the app registry.
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
13. **Migrations:** `server/src/db/migrations/` only, sequential 3-digit prefix, additive and idempotent. **Never edit an applied migration.** Destructive changes need explicit sign-off. One shared sequence across every app — filenames tag the app: `NNN_<app-slug>_<subject>.sql`.
14. **No dependency before the phase that needs it.** No ORM. Redis runs but nothing connects to it until Phase 6 — don't claim queueing works. This includes an LLM/embeddings SDK for TaxGuard AI (Phase 13) — the prior blanket "no LLM" ruling is reversed for that phase specifically, see [docs/roadmap.md](docs/roadmap.md#phase-2-as-delivered).
15. **Every module ships tests**, including a cross-tenant isolation test. Without one it is not done — one per app, not one for the whole suite.
16. **App boundaries are namespaces, not tenancy.** `org_id` is still the only access-control boundary inside an app's own routes. No app reads another app's tables directly — cross-app effects go through LedgerCore's GL via `source_type`/`source_id`. `config/apps.ts` is the single source of truth for which slugs exist.

## Standing task: study notes

The user is preparing for **Backend / React + Node.js + TypeScript** interviews. `study/` holds interview notes generated from this project's own decisions.

**Every change that introduces something new owes a study note in the same change** — a Node/Express mechanism, a TypeScript feature, a PostgreSQL feature, a React pattern, an architectural pattern, or a data-structure choice. Extend the existing note if the topic is already covered; create one from `study/TEMPLATE.md` if not. Update the index and coverage tracker in [study/README.md](study/README.md).

Notes need **mechanism-level depth** (how it works underneath, not what the API is), the **alternatives we rejected and why**, gotchas, and **4–8 interview questions with full written answers**. Accuracy outranks completeness — the user will repeat these in an interview, so state the version you verified against and flag anything you are unsure of. Convention: [docs/study-notes.md](docs/study-notes.md).

## Docs

Read the relevant file before working — they are not in context by default.

| File | Read it when |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | Starting any work — phase order, gates, and each app's intended DB pattern |
| [docs/guardrails.md](docs/guardrails.md) | Writing any server code; also holds why the old build was scrapped |
| [docs/architecture.md](docs/architecture.md) | Touching auth, tenancy, RBAC, or the platform/app split; adding files (layer-first layout, module delivery order) |
| [docs/schema.md](docs/schema.md) | Writing a migration or a query — table definitions, constraints, default chart of accounts |
| [docs/api.md](docs/api.md) | Adding or changing a route — response shape, pagination, error conventions |
| [docs/development.md](docs/development.md) | Running the stack, env vars, Docker, adding a dependency |
| [docs/testing.md](docs/testing.md) | Writing tests — unit vs integration tiers and what each must cover |
| [docs/study-notes.md](docs/study-notes.md) | Writing a study note — required sections and the accuracy bar |

## Keeping docs honest

The prior build's docs drifted from reality and the drift hid a structural problem until a rewrite was cheaper than a repair. When a change lands, update the affected doc in the same pass — `docs/api.md` for routes, `docs/schema.md` for tables, `docs/roadmap.md` for phase status. Claiming something works when it doesn't is worse than saying nothing.
