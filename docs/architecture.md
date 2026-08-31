# Architecture — Tenancy Model & Repository Layout

## Suite structure

AutoLedger is the suite name. Inside it are seven portfolio applications — LedgerCore, TaxGuard AI, AP-Flow, FP&A Engine, UnitEcon, BoardDeck Automator, ForecasterPro — see [roadmap.md](roadmap.md#app-map) for what each one does.

Two layers, cutting across every part of the stack:

- **Platform layer** — identity, tenancy, RBAC, the app registry, health. App-less: `/api/v1/auth`, `/api/v1/organizations`, `/api/v1/apps`, `/api/v1/health`. Built once, in Phases 1–2, and never duplicated per app.
- **App layer** — everything else. Each app's routes mount at `/api/v1/<app-slug>/<module>` (see `config/apps.ts` for the slugs, e.g. `ledger-core`, `taxguard`). An app's own frontend pages live under `client/src/Pages/<app-slug>/`.

All seven apps share one database, one `organizations` table as the tenant boundary, and one migration sequence — there is no per-app database and no per-app auth. LedgerCore's General Ledger is additionally shared *data*, not just shared *infrastructure*: every other app posts into it via `source_type` / `source_id` rather than keeping its own notion of money (see [schema.md](schema.md)).

The app slug is a **routing namespace, not a tenancy boundary**. `org_id` remains the only thing that scopes data access — a request to `/api/v1/ap-flow/invoices` is still scoped by the caller's `org_id`, exactly like a platform route. An app never reads another app's tables directly.

## Multi-tenancy (foundational)

An ERP is operated by a company, not a person. A warehouse, purchase order, or payroll run belongs to an **organization** that many users with different roles act upon. This is baked into migration 001 — it is not a retrofit. Scoping by `user_id` was the prior build's fatal design error.

### The model

1. **`organizations`** — the tenant boundary and the scope of all business data.
2. **`users`** — a global identity. One user may belong to several organizations.
3. **`organization_members (org_id, user_id, role)`** — membership plus role. Permissions are per organization.
4. **Every domain table** carries `org_id UUID NOT NULL REFERENCES organizations(id)`. No exceptions. `users` and `refresh_tokens` are the only org-less tables, because identity precedes membership.
5. **Auth middleware** resolves the authenticated user *and* their active organization + role, attaching all three to `req.user` as `{ id, orgId, role }`. Every service takes `orgId` as its first argument.
6. **RBAC middleware** gates routes by role, e.g. `requireRole('ADMIN', 'ACCOUNTANT')`.
7. `user_id` on transactional rows means "created by" — an audit field, never an access check.

### Active organization resolution

The access token carries the active `org_id`. Switching organization means issuing a new access token via an explicit endpoint (`POST /auth/switch-org`), which re-validates membership.

**Never read the active org from a request header, query param, or body** — that is a trivially forgeable tenant boundary.

`switch-org` rotates the **refresh** token too, not just the access token. The refresh row stores the session's active org, so replacing only the access token would let the next silent refresh read the stale value and quietly drag the user back to the previous organization.

### The 15-minute revocation window — a deliberate trade

`middleware/auth.ts` performs **no database query**. The token's signature proves we issued it and that it was not altered, and that is treated as sufficient for its 15-minute life.

The consequence, stated plainly: **removing someone from an organization does not take effect until their current access token expires — up to 15 minutes.** Refresh *does* re-validate membership, so the window is bounded and cannot be extended.

The alternative — checking membership on every request — puts a query in front of every route and gives up the reason for using stateless tokens at all. If a module ever needs immediate revocation (a compliance requirement, say), the answer is a short-lived denylist in Redis from Phase 5, not a per-request join.

### Roles

Start with a small fixed set and expand only when a module needs it: `OWNER`, `ADMIN`, `ACCOUNTANT`, `VIEWER`. Stored as a TEXT column with a CHECK constraint (Phase 1).

Move to `roles`/`permissions` tables only when granular per-module permissions genuinely require it — do not build a permission engine before there are permissions to manage.

---

## Repository layout

### Current (verified 2026-08-31, after Phase 2)

Phase 2 added, on the server: `config/apps.ts`, `types/apps.ts`, `services/appService.ts`, `controllers/appController.ts`, `routes/apps.ts`, and `__tests__/platform/apps.test.ts`.

On the client: `apps/registry.ts`, `apps/useActiveApp.ts`, `Pages/AppChooserPage.tsx`, `components/layout/AppShell.tsx`, and `__tests__/AppChooserPage.test.tsx`. Two Phase 1 files were renamed rather than added: `components/layout/AppLayout.tsx` → `PlatformLayout.tsx`, and `Pages/DashboardPage.tsx` → `Pages/AccountPage.tsx` (served at `/account` instead of `/`).

Phase 1 added, on the server: `db/migrate.ts`, `db/reset.ts`, `db/migrations/001_organizations_and_users.sql`, `types/auth.ts`, `types/express.d.ts`, `utils/jwt.ts`, `utils/cookies.ts`, `utils/validate.ts`, `utils/requireUser.ts`, `services/authService.ts`, `services/organizationService.ts`, `middleware/auth.ts`, `middleware/rbac.ts`, `controllers/authController.ts`, `controllers/organizationController.ts`, `routes/auth.ts`, `routes/organizations.ts`, and five test files plus `__tests__/setup/` and `__tests__/helpers/`.

On the client: `context/AuthContext.tsx`, `context/OrgContext.tsx`, `components/ProtectedRoute.tsx`, `components/layout/OrgSwitcher.tsx`, `Pages/auth/{LoginPage,RegisterPage}.tsx`, `Pages/NotFoundPage.tsx`, `utils/fetchWithAutoRefresh.ts`, `vitest.config.ts` and `src/__tests__/`.

The Phase 0 tree below is unchanged and still accurate for the files it lists.

### As of Phase 0 (2026-07-30)

```text
AutoLedger/
├── docker-compose.yml          ← postgres + redis only; app runs on the host
├── .env.example                ← PG_*/REDIS_PORT for compose; no app secrets
├── .gitignore
├── CLAUDE.md
├── README.md
├── docs/                       ← this directory
├── study/                      ← interview-prep notes
├── server/
│   ├── package.json
│   ├── tsconfig.json           ← type-checks (noEmit)
│   ├── tsconfig.build.json     ← emits src/ → dist/
│   ├── vitest.config.ts
│   ├── .env.example
│   └── src/
│       ├── index.ts            ← listen + graceful shutdown
│       ├── app.ts              ← createApp(): middleware + route mounting
│       ├── config/
│       │   ├── env.ts          ← fail-fast env parsing
│       │   └── constants.ts    ← API_VERSION, body limit, shutdown timeout
│       ├── controllers/healthController.ts
│       ├── services/healthService.ts
│       ├── routes/
│       │   ├── index.ts        ← the /api/v1 router; modules mount here
│       │   └── health.ts
│       ├── middleware/errorHandler.ts
│       ├── db/connect.ts       ← pg Pool singleton
│       ├── utils/apiError.ts
│       └── __tests__/
│           ├── app.test.ts     ← unit: middleware wiring
│           └── health.test.ts  ← integration: real Postgres
└── client/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── .env.example
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx             ← Phase 0 status page
        ├── index.css
        ├── vite-env.d.ts       ← types import.meta.env
        └── services/fetchServices.ts
```

There is no `Flowchart/` directory — the `.drawio` files an earlier version of this document listed do not exist on disk.

`server/src/db/migrations/`, `middleware/auth.ts` and `types/express.d.ts` landed in Phase 1 (listed above). The remainder of the target tree below arrives with the phase that needs it.

### Target layout

Layer-first, with an **app** subfolder inside each layer (platform code — auth, organizations, apps — stays at the layer root, unprefixed). Do **not** invent a parallel `src/modules/` or `src/apps/` tree on the server.

```text
server/
├── src/
│   ├── index.ts                    ← process lifecycle: listen + graceful shutdown
│   ├── app.ts                      ← createApp(): middleware + route mounting
│   ├── config/
│   │   ├── env.ts                  ← fail-fast env parsing, the only reader of process.env
│   │   ├── constants.ts            ← API_VERSION and other cross-layer values
│   │   └── apps.ts                 ← the app registry: slugs, names, status
│   ├── controllers/                ← thin HTTP adapters, zero SQL
│   │   ├── authController.ts       ← platform, unprefixed
│   │   └── ledger-core/journalController.ts
│   ├── services/                   ← ALL DB logic lives here
│   │   ├── authService.ts          ← platform, unprefixed
│   │   ├── appService.ts           ← platform, unprefixed
│   │   └── ledger-core/journalService.ts
│   ├── routes/
│   │   ├── index.ts                ← the /api/v1 router; every app mounts here
│   │   ├── auth.ts                 ← platform, unprefixed
│   │   ├── apps.ts                 ← platform, unprefixed
│   │   └── ledger-core/journalRoutes.ts
│   ├── middleware/
│   │   ├── auth.ts                 ← JWT verify + active-org resolution
│   │   ├── rbac.ts                 ← requireRole / requirePermission
│   │   ├── idempotency.ts          ← Phase 9
│   │   └── errorHandler.ts
│   ├── utils/
│   │   ├── apiError.ts             ← ApiError(status, message)
│   │   ├── jwt.ts
│   │   └── money.ts                ← toCents / formatCents, single source of truth
│   ├── db/
│   │   ├── connect.ts              ← pg Pool singleton
│   │   ├── migrate.ts              ← migration runner
│   │   ├── reset.ts                ← dev-only DB reset
│   │   └── migrations/             ← ONLY migration directory, one sequence for every app
│   ├── types/
│   │   ├── apps.ts                 ← platform, unprefixed
│   │   ├── auth.ts                 ← platform, unprefixed
│   │   └── ledger-core.ts
│   └── __tests__/
│       ├── platform/apps.test.ts
│       └── ledger-core/journal.test.ts
├── tsconfig.json                   ← type-check config (noEmit)
├── tsconfig.build.json             ← emit config
├── vitest.config.ts
└── package.json

client/
├── src/
│   ├── main.tsx
│   ├── App.tsx                     ← router + AuthProvider + OrgProvider
│   ├── context/
│   │   ├── AuthContext.tsx
│   │   └── OrgContext.tsx          ← active organization + switcher
│   ├── apps/
│   │   ├── registry.ts             ← slug → element, for route wiring
│   │   └── useActiveApp.ts         ← resolves :appSlug against GET /apps
│   ├── Pages/                      ← capital P
│   │   ├── AppChooserPage.tsx      ← "/", one card per app
│   │   ├── AccountPage.tsx         ← "/account", suite-level identity/org/session
│   │   └── ledger-core/            ← app pages nest under Pages/<app-slug>/
│   ├── components/
│   │   ├── ProtectedRoute.tsx
│   │   └── layout/
│   │       ├── PlatformLayout.tsx  ← suite chrome: brand, org switcher, account
│   │       ├── AppShell.tsx        ← per-app chrome, mounted at /app/:appSlug
│   │       └── OrgSwitcher.tsx
│   ├── services/fetchServices.ts
│   └── utils/fetchWithAutoRefresh.ts
├── index.html
├── vite.config.ts
└── package.json
```

No `Dockerfile` or `entrypoint.sh` in either tree — the application processes run on the host during development, and a production image is deployment work. See [development.md](development.md#why-not-full-docker).

---

## Module delivery order

Each new module lands in this order:

**migration(s) → types → service(s) → controller(s) → routes → mount in `routes/index.ts` → tests → docs → client pages**

Mount under `/api/v1/<app-slug>/<module>` by adding one `apiRouter.use('/<app-slug>', <app>Routes)` line to `server/src/routes/index.ts` (platform routes stay unprefixed). Nothing mounts directly on the app — `app.ts` knows only about the single versioned router. Frontend pages go under `client/src/Pages/<app-slug>/`.

In the same change, update: the status in `CLAUDE.md`, [roadmap.md](roadmap.md), [api.md](api.md), and [schema.md](schema.md).
