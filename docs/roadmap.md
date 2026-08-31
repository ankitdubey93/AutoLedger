# Build Roadmap & App Map

AutoLedger is a suite, not a single application. Phases 0–1 built the platform every app in the suite shares — identity, tenancy, RBAC. Phase 2 added the platform layer that turns "one app" into "a chooser over several apps." From Phase 3 onward, each phase belongs to exactly one app.

Phases are sequential. Where a **Gate** is listed, do not start the gated work first — ask before reordering.

| Phase | Scope | Gate |
|---|---|---|
| **0 ✅ done** | Scaffold — see [Phase 0, as delivered](#phase-0-as-delivered) below | Blocks everything |
| **1 ✅ done** | Identity + tenancy — see [Phase 1, as delivered](#phase-1-as-delivered) below | Blocks everything below |
| **2 ✅ done** | Platform: app registry, chooser, app-scoped routing — see [Phase 2, as delivered](#phase-2-as-delivered) below | Blocks 3+ |
| **3** | LedgerCore — GL core: chart of accounts, journal entries (create/list), reversing entries, trial balance — all `org_id` scoped, all `BIGINT` cents. **Also owes: seed the default chart at registration, plus a backfill for organizations created before this phase** ([schema.md](schema.md)) | Blocks 4+ |
| **4** | LedgerCore — GL completion: fiscal periods with close/lock, P&L, balance sheet, AR/AP subledgers | |
| **5** | Shared — CDC audit trail: `audit_logs` JSONB table, `OLD`/`NEW` snapshot triggers on every financial table, across every app | Blocks compliance claims |
| **6** | Shared — background jobs: `bullmq` + `ioredis`, Redis healthcheck + `depends_on`, worker process, retry/DLQ policy | Blocks 8, 12, 13 |
| **7** | LedgerCore — multi-currency FX engine + QuickBooks API sync | Needs 6 |
| **8** | AP-Flow — multimodal OCR invoice parsing, 3-way matching, COGS tracking | Needs 6 |
| **9** | FP&A Engine — 3-statement financial linking, scenario modeling, cash runway forecasting | Needs 4 |
| **10** | ForecasterPro — driver-based rolling forecasting, headcount planning, zero-based budgeting | Needs 9 |
| **11** | UnitEcon — cohort retention matrices, LTV/CAC ratios, Price-Volume-Mix variance | Needs 4 |
| **12** | BoardDeck Automator — monthly close automation, BvA variance, automated `.pptx` deck generation | Needs 6, 10 |
| **13** | TaxGuard AI — tax act parsing, RAG over `pgvector`, PII redaction | Needs 6 |

**Integration tests are not a phase.** They start in Phase 1 and grow with every module — see [testing.md](testing.md).

---

## Phase 0, as delivered

The stack boots and browser → Express → PostgreSQL is connected. No business functionality exists.

**Landed:**

- `server/` — Express 5 + TypeScript, layer-first (`controllers/`, `services/`, `routes/`, `middleware/`, `db/`, `config/`, `utils/`, `__tests__/`)
- Strict TS config, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and friends that `strict` does not include. `tsconfig.json` type-checks; `tsconfig.build.json` emits
- `pg` Pool singleton with an idle-client `error` listener
- Fail-fast environment parsing that reports every missing variable at once
- `errorHandler` + `notFoundHandler`; `ApiError` as the one client-visible error type
- `GET /api/v1/health` — a real `SELECT 1`, `200`/`503`
- Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting, evict idle keep-alive sockets, drain, `pool.end()`, forced exit after 10s
- `client/` — React 19 + Vite 8, typed API layer in `src/services/fetchServices.ts`, a status page proving the three tiers
- Vitest with `globals: true`; 4 tests passing (3 unit on app wiring, 1 integration against real Postgres)
- `docker-compose.yml` reduced to `postgres` + `redis`; `JWT_SECRET` deleted
- Strays removed: root `package.json`, `_metadata.json`

**Deliberately changed from the original Phase 0 scope:**

| Planned | Actual | Why |
|---|---|---|
| `server/Dockerfile`, `client/Dockerfile`, `entrypoint.sh` | Not built. Docker runs Postgres + Redis only; app processes run on the host | Dev-loop speed and native file watching. See [development.md](development.md#why-not-full-docker). Containerising the app belongs with deployment, where a multi-stage production image — not a dev image with a source mount — is the real requirement |
| `entrypoint.sh` runs migrations + full test suite before boot | Not simulated | Its real home is CI, which is not set up yet. Tests are run manually with `npm test` |
| `git init` + first commit | Already a git repo with history | Done before Phase 0 started; the reset predates it |

**Also not built, and not owed until later:** `react-router-dom` (Phase 1, with the second page), `utils/money.ts` (Phase 3, with the first money column), `types/express.d.ts` and `req.user` (Phase 1), the migration runner and `npm run migrate` / `db:reset` (Phase 1).

---

## Phase 1, as delivered

You can register, sign in, stay signed in across reloads, switch organizations, and see a dashboard of real data. The tenancy boundary is enforced and tested.

**Landed:**

- Migration runner (`db/migrate.ts`) — sorted application, per-file transaction, `schema_migrations` ledger, session-level advisory lock, filename/gap validation, and a **SHA-256 checksum guard that refuses to run when an applied migration has been edited**. Plus `db/reset.ts`, `npm run migrate`, `npm run db:reset`
- `001_organizations_and_users.sql` — `organizations`, `users`, `organization_members`, `refresh_tokens`, the shared `set_updated_at()` trigger, `UNIQUE (LOWER(email))`, role and currency CHECKs, FK indexes
- `authService` (all SQL) — register in one transaction with `ON CONFLICT` slug allocation, login with a dummy-hash timing equaliser, refresh rotation via `DELETE … RETURNING` with reuse detection and family invalidation, switch-org, logout
- `middleware/auth.ts` (token-only, no DB round trip) and `middleware/rbac.ts` (`requireRole`)
- `utils/jwt.ts`, `utils/cookies.ts`, `utils/validate.ts` (hand-rolled, no zod), `utils/requireUser.ts`, `types/express.d.ts`
- `/api/v1/auth` (6 routes) and `/api/v1/organizations` (2 routes) — see [api.md](api.md)
- Client: `react-router-dom`, `AuthContext` (three-state machine), `OrgContext`, `ProtectedRoute`, `AppLayout` + `OrgSwitcher`, login/register/dashboard/404 pages, single-flight `fetchWithAutoRefresh`
- **91 server tests** (up from 4) including the cross-tenant isolation suite, and **12 client tests** — the client had no runner before this phase

**Deliberately changed from the original Phase 1 scope:**

| Planned | Actual | Why |
|---|---|---|
| `GET /auth/refresh` | `POST /auth/refresh` | Rotation is state-changing, and `SameSite=Lax` still sends cookies on a top-level cross-site navigation — a `GET` would be a logout-CSRF hole |
| `register` seeds the chart of accounts | Deferred to Phase 3 (was Phase 2 before the platform layer was inserted) | `accounts` belongs to LedgerCore, not the platform. LedgerCore's first phase inherits a backfill obligation |
| `refresh_tokens.token` | `refresh_tokens.token_hash` | A dump of the table must not yield usable sessions |
| — | Added `GET /organizations/members` | Phase 1 otherwise has no org-scoped table, so the mandatory cross-tenant isolation test would have had nothing to test and `rbac.ts` nothing to guard |

**Known gaps, deliberate:** no login rate limiting (`express-rate-limit` is a scheduled decision in [development.md](development.md)); no email verification (columns exist, nothing writes them); a revoked membership stays effective for up to 15 minutes, which is the trade the short access-token TTL buys ([architecture.md](architecture.md)).

---

## Phase 2, as delivered

AutoLedger's post-login landing page is now an app chooser, not a single dashboard. `AppLayout` was renamed `PlatformLayout` and now hosts two things: the chooser at `/`, and a per-app shell (`AppShell`) mounted at `/app/:appSlug`. The old dashboard content (identity, organization, membership, session) moved to `/account` — it is suite-level, not app-level, and does not belong on either the chooser or inside an app.

**Landed:**

- `server/src/config/apps.ts` — the static app registry, `as const satisfies readonly AppDefinition[]`, one entry per app in the [App map](#app-map) below
- `GET /api/v1/apps` — authenticated, not role-gated; returns the registry as-is (no per-org entitlement yet)
- Client: `apps/registry.ts` (slug → element, for route wiring only — display data comes from the API), `useActiveApp` hook, `AppChooserPage` at `/`, `AppShell` at `/app/:appSlug`, `AccountPage` at `/account` (renamed from `DashboardPage`)
- Nothing under any app slug has features yet. `AppShell` renders a header and an empty outlet for `ledger-core` (the only `'building'` app); every other slug redirects back to `/`

**Deliberately changed from the original module-based roadmap:**

The roadmap through Phase 15 used to describe one ERP with modules (inventory, procurement, MRP, payroll, QMS, CRM, EAM) all posting into a shared GL. That plan is replaced by the [App map](#app-map) below — seven separate portfolio applications, each demonstrating a different accounting or engineering skill, sharing one identity/tenancy platform and (for LedgerCore specifically) one GL. See [Dropped from scope](#dropped-from-scope).

**LLM integration is no longer out of scope.** The previous ruling ("Do not add an LLM dependency, API key, or provider SDK without an explicit decision recorded here first") is reversed by this entry: TaxGuard AI (Phase 13) requires RAG over `pgvector` and an LLM/embeddings SDK. The decision is recorded here, as that ruling required.

**No migration in this phase.** The app registry is a static code list, not a database table — there is no per-org entitlement to persist yet. If entitlement becomes real (e.g. a paid tier that unlocks specific apps), it becomes a migration then, not now.

---

## App map

The domain, headline skills, and DB/engineering pattern for each app in the suite.

### LedgerCore — Core Accounting & Systems — Phases 3–4, 7

The system of record every other app posts into. Double-entry integrity, DB constraints, multi-currency, and a QuickBooks API sync.

*Includes:* chart of accounts, manual journal entries, reversing entries, trial balance, fiscal periods with close/lock, P&L, balance sheet, AR/AP subledgers, multi-currency FX, QuickBooks Online sync.

*Pattern:* strict double-entry validation inside `BEGIN...COMMIT`, all amounts integer cents. `source_type` / `source_id` on `journal_entries` is the hook every other app uses to post into the GL.

### TaxGuard AI — Compliance & AI Workflows — Phase 13

Tax-law question answering grounded in real statute text, not model recall.

*Pattern:* RAG over `pgvector`, PII redaction before any text reaches a model provider, tax act parsing into retrievable chunks with citations.

### AP-Flow — Operational Accounting — Phase 8

Invoice capture to posted, matched, paid.

*Pattern:* multimodal OCR invoice parsing, automated 3-way matching across PO, receipt, and invoice, COGS tracking. Posts into LedgerCore via `source_type = 'ap_flow'`.

### FP&A Engine — Financial Modeling — Phase 9

A linked 3-statement model you can stress-test.

*Pattern:* 3-statement financial linking (income statement → balance sheet → cash flow, changes propagate), scenario modeling, cash runway forecasting.

### ForecasterPro — Budgeting & Planning — Phase 10

Driver-based forecasts instead of a spreadsheet copied forward.

*Pattern:* driver-based rolling forecasting, headcount planning, zero-based budgeting. Builds on FP&A Engine's linked model.

### UnitEcon — Commercial Analytics — Phase 11

Unit economics, not just revenue.

*Pattern:* cohort retention matrices, LTV/CAC ratios, Price-Volume-Mix variance decomposition.

### BoardDeck Automator — Board Reporting & Close — Phase 12

Close the books, generate the board deck.

*Pattern:* monthly close automation, budget-vs-actual (BvA) variance, automated `.pptx` deck generation. Depends on background jobs (Phase 6) and ForecasterPro's budgets (Phase 10).

---

## Cross-cutting infrastructure

**Audit trail & CDC (Phase 5).** System-wide PostgreSQL triggers capturing `OLD` and `NEW` row states into a centralized, immutable `audit_logs` table as `JSONB`, alongside `org_id`, actor `user_id`, table name, operation, and timestamp — shared across every app. This is distinct from `updated_at` timestamp triggers — write both, but do not confuse one for the other. No compliance claim is valid until this lands.

**Background jobs (Phase 6).** `bullmq` + `ioredis`, a worker process, retry/DLQ policy — shared infrastructure that AP-Flow, ForecasterPro, BoardDeck Automator, and TaxGuard AI all build on.

---

## Dropped from scope

The prior roadmap (Phases 6–14, before this restructure) planned Inventory & WMS, Procurement/P2P, Manufacturing/MRP, HR & Payroll, QMS, CRM, and EAM as modules of one ERP. None of that scope survives the restructure — the seven apps above are the roadmap now. The engineering patterns those modules would have demonstrated are kept here only as a record, since some are genuinely interesting interview material even though nothing will be built against them:

- **Inventory & WMS** — pessimistic locking (`SELECT ... FOR UPDATE`) on stock rows; append-only movement ledger; current quantity always derived, never a mutable counter.
- **Procurement / P2P** — FSM-enforced status progression; automated 3-way matching (the pattern AP-Flow now owns instead).
- **Manufacturing / MRP & BOM** — `WITH RECURSIVE` CTEs to resolve nested component trees; mandatory cycle detection.
- **HR & Payroll** — batch processing via cron-triggered jobs; `EXCLUDE USING GIST` constraints (requires `btree_gist`) to make overlapping leave ranges physically impossible.
- **QMS** — customer-definable inspection forms as `JSONB`, validated with `Ajv`, schema-versioned.
- **CRM** — full-text and fuzzy search via `pg_trgm` trigram indexes.
- **EAM** — nightly cron job computing depreciation and auto-posting balancing journal entries; must be idempotent.

**MagicJournal**, the prior build's rule-based keyword-scoring engine that drafted journal entries from plain English, is also dropped rather than revived — TaxGuard AI's RAG approach supersedes the idea it was reaching for, done properly this time (a database-backed, `org_id`-scoped corpus instead of a tracked CSV mutated at runtime).
