# Architecture — Tenancy Model & Repository Layout

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

### Roles

Start with a small fixed set and expand only when a module needs it: `OWNER`, `ADMIN`, `ACCOUNTANT`, `VIEWER`. Stored as a TEXT column with a CHECK constraint (Phase 1).

Move to `roles`/`permissions` tables only when granular per-module permissions genuinely require it — do not build a permission engine before there are permissions to manage.

---

## Repository layout

### Current (verified 2026-07-30, after Phase 0)

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

`server/src/db/migrations/`, `middleware/auth.ts`, `types/express.d.ts` and the rest of the target tree below arrive with the phase that needs them.

### Target layout

Layer-first, with a module subfolder inside each layer. Do **not** invent a parallel `src/modules/` tree.

```text
server/
├── src/
│   ├── index.ts                    ← process lifecycle: listen + graceful shutdown
│   ├── app.ts                      ← createApp(): middleware + route mounting
│   ├── config/
│   │   ├── env.ts                  ← fail-fast env parsing, the only reader of process.env
│   │   └── constants.ts            ← API_VERSION and other cross-layer values
│   ├── controllers/                ← thin HTTP adapters, zero SQL
│   │   ├── authController.ts
│   │   └── inventory/stockController.ts
│   ├── services/                   ← ALL DB logic lives here
│   │   ├── authService.ts
│   │   ├── journalService.ts
│   │   └── inventory/stockService.ts
│   ├── routes/
│   │   ├── index.ts                ← the /api/v1 router; every module mounts here
│   │   ├── auth.ts
│   │   └── inventory/stockRoutes.ts
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
│   │   └── migrations/             ← ONLY migration directory
│   ├── types/
│   │   ├── accounting.ts
│   │   ├── inventory.ts
│   │   └── express.d.ts            ← req.user = { id, orgId, role }
│   └── __tests__/
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
│   ├── Pages/                      ← capital P; module pages under Pages/<module>/
│   ├── components/
│   │   ├── ProtectedRoute.tsx
│   │   └── layout/
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

**migration(s) → types → service(s) → controller(s) → routes → mount in `routes/index.ts` → tests → client pages**

Mount under `/api/v1/<module>` by adding one `apiRouter.use(...)` line to `server/src/routes/index.ts`. Nothing mounts directly on the app — `app.ts` knows only about the single versioned router. Frontend pages go under `client/src/Pages/<module>/`.

In the same change, update: the status in `CLAUDE.md`, [roadmap.md](roadmap.md), [api.md](api.md), and [schema.md](schema.md).
