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

### Current (verified 2026-09-10, after Phase 10)

**This delta list has a known gap: Phases 7, 8, 9, and 9.5 were never backfilled here** — their entries in [roadmap.md](roadmap.md) (search "as delivered") are the accurate, current record of what each added; this file's list resumes below at Phase 6, the last phase it covered before Phase 10.

**Phase 10 (2026-09-10)** added, on the server: `db/migrations/031_ap-flow_documents.sql`; `types/ap-flow.ts` (`ApFlowDocumentStatus`, `AP_FLOW_DOCUMENT_TRANSITIONS`, OCR/PII/extraction types); `utils/{checksum,pii}.ts` (hand-written Luhn/Verhoeff, PII span detection — zero dependencies); `services/redactionService.ts` (unprefixed, shared — `rasterize`, `tesseractOcr`, `redactPage`); `services/ap-flow/{apFlowDocumentService,extractionService}.ts`; `schemas/ap-flow/{documentSchema,extractionSchema}.ts`; `controllers/ap-flow/apFlowDocumentController.ts`; `routes/ap-flow/{index,documentRoutes}.ts`; `queue/handlers/apFlowExtractHandler.ts`; and `__tests__/{checksum,pii,redaction,ap-flow/{documents,apFlowConstraints,extraction,pipeline}}.test.ts`. `package.json` gained four dependencies: `tesseract.js`, `sharp`, `pdfjs-dist`, `@anthropic-ai/sdk`.

Edited in place: `config/apps.ts` (`ap-flow` → `'building'`), `config/constants.ts` (`AP_FLOW_*` constants), `config/env.ts` (`ANTHROPIC_API_KEY`, optional), `types/documents.ts` (`ap-flow: ['ap_flow_document']` in `DOCUMENT_ENTITY_TYPES_BY_APP`), `types/jobs.ts` (`ap-flow-extract` queue + payload), `queue/worker.ts` (wires the new handler), `routes/index.ts` (mounts `/ap-flow`), `__tests__/helpers/factories.ts` (`resetTables()` truncates the three new tables).

On the client: `Pages/ap-flow/{ApFlowRoutes,ApFlowDocumentsPage,ApFlowDocumentDetailPage}.tsx`, `__tests__/apFlowDocuments.test.tsx`. Edited in place: `apps/registry.ts` (`'ap-flow'` entry), `services/fetchServices.ts` (AP-Flow types and wrappers). **One promotion, not an addition:** `Pages/ledger-core/{BackLink,ConfirmDialog,money}.tsx|ts` moved to `components/{BackLink,ConfirmDialog}.tsx` and `utils/money.ts` — AP-Flow needed all three, and importing from another app's page directory would mirror a rule-16 violation; every importer's path was rewritten in the same change, behaviour otherwise untouched (client test count unchanged by the move itself).

**Phase 6 (2026-09-04)** added, on the server: `db/migrations/019_ledger-core_bank_reconciliation.sql`; `utils/{csv,dateParse,levenshtein,matchScore}.ts` (all hand-written, zero new dependencies — a two-pass CSV state machine, an `ISO`/`DMY`/`MDY` date parser, a rolling-array Levenshtein distance, and the 40/30/30 confidence-scoring engine); `schemas/ledger-core/bankSchema.ts`; `services/ledger-core/{bankImportService,bankMatchService}.ts`; `controllers/ledger-core/{bankImportController,bankTransactionController}.ts`; `routes/ledger-core/{bankImportRoutes,bankTransactionRoutes}.ts`; and `__tests__/{csv,dateParse,levenshtein,matchScore}.test.ts` plus `__tests__/ledger-core/{bankConstraints,bankImports,bankMatching,bankReconciliation}.test.ts` and `__tests__/helpers/bankFixture.ts`. `package.json` unchanged — no new dependency.

Edited in place: `utils/money.ts` (added `parseMoneyText`, untrusted-text → cents with no intermediate float), `config/constants.ts` (added `MAX_CSV_CHARS`), `services/ledger-core/paymentService.ts` (`createPayment`/`voidPayment` split into `createPaymentOnClient`/`voidPaymentOnClient`, mirroring `journalService`'s existing split, so `bankMatchService` can post or void a payment inside its own transaction), `services/ledger-core/reportService.ts` (added `bankReconciliation`), `controllers/ledger-core/reportController.ts` and `routes/ledger-core/reportRoutes.ts` (added `bankReconciliation` / `GET /bank-reconciliation`), `routes/ledger-core/index.ts` (mounts the two new routers), `types/ledger-core.ts` (`BankTransactionStatus`, `BANK_TRANSACTION_TRANSITIONS`, `BankStatementImport`, `BankTransaction`, `BankMatchSuggestion`, `BankReconciliationReport`), `__tests__/helpers/factories.ts` (`resetTables()` truncates the three new tables).

On the client: `Pages/ledger-core/{BankImportPage,BankTransactionsPage,BankReconciliationPage,MatchScoreBadge}.tsx` (new), plus three new test files (`ledgerCoreBankImport`, `ledgerCoreBankTransactions`, `ledgerCoreBankReconciliation`). Edited in place: `services/fetchServices.ts` (the bank-reconciliation types and wrappers), `Pages/ledger-core/{LedgerCoreRoutes,LedgerCoreSidebar}.tsx` (the `bank`/`bank/import`/`bank/reconciliation` routes and a new "Banking" rail group).

**Phase 5 (2026-09-04)** added, on the server: `db/migrations/{017_platform_audit_logs,018_platform_audit_triggers}.sql`, `db/integrity.ts`, `db/transaction.ts` (`beginTransaction`/`withTransaction`, the new sanctioned entry point for every write transaction), `scripts/verifyIntegrity.ts`, `utils/requestContext.ts` (`AsyncLocalStorage`-backed `RequestContext`), `middleware/requestContext.ts` (`attachRequestContext`, mounted first in `app.ts`, before `cors`), `types/audit.ts`, `services/auditService.ts`, `controllers/auditController.ts`, `routes/auditLogs.ts` (mounted platform-level at `/api/v1/audit-logs`, not under any app slug), and `__tests__/{integrity,platform/auditTrail,platform/auditActor,platform/auditLogs}.test.ts`. `package.json` gained the `verify:integrity` script; no new dependency — `AsyncLocalStorage` is `node:async_hooks`.

Edited in place: `middleware/auth.ts` (`authenticate` now fills `userId`/`orgId` onto the request context once the token verifies); every service holding a hand-rolled transaction (`authService`, `organizationService`, `ledger-core/{accountService,customerService,vendorService,invoiceSettingsService,settingsService,invoiceService,billService,journalService,paymentService,fiscalPeriodService}`) — the 20 bare `client.query('BEGIN')` call sites became `beginTransaction(client)`, and the 10 single-statement writes that previously ran on `pool` directly (each service's `create`/`update`/`delete`) now run inside `withTransaction(...)`, so every write has a transaction for the audit trigger's session-variable context to attach to (guardrails rule 5, extended); `routes/index.ts` (mounts `auditRoutes`).

On the client: `Pages/ledger-core/AuditLogPage.tsx` (new), `Pages/ledger-core/{LedgerCoreRoutes,LedgerCoreSidebar}.tsx` (the `audit` route and rail entry), `services/fetchServices.ts` (`AuditLogEntry`/`AuditLogDetail`/`getAuditLogs`/`getAuditLogDetail`), plus `__tests__/ledgerCoreAuditLog.test.tsx`.

**Phase 3.8 (2026-09-04)** added, on the server: `db/migrations/{006_platform_organization_tax_ids,007_ledger-core_invoice_settings,008_ledger-core_customers,009_ledger-core_invoices,010_ledger-core_invoice_lines_org_index}.sql`, `schemas/ledger-core/{customerSchema,invoiceSchema,invoiceSettingsSchema}.ts`, `services/ledger-core/{customerService,invoiceService,invoiceSettingsService}.ts`, `controllers/ledger-core/{customerController,invoiceController,invoiceSettingsController}.ts`, `routes/ledger-core/{customerRoutes,invoiceRoutes}.ts`, and `__tests__/{organizations,ledger-core/customers,ledger-core/invoices,ledger-core/invoiceConstraints,ledger-core/invoiceSettings}.test.ts`. Edited in place: `services/ledger-core/journalService.ts` (added `createEntryOnClient`/`reverseEntryOnClient`, the transaction-client variants `invoiceService` posts through), `utils/money.ts` (added `scaleCents`), `types/{auth,ledger-core}.ts` (organization tax fields; `Customer`, `Invoice*`, `InvoiceSettings`, the `INVOICE_STATUSES`/`INVOICE_TRANSITIONS` FSM), `services/organizationService.ts` and `schemas/organizationSchema.ts` (tax/business number fields on `updateOrganization`), `routes/ledger-core/{index,settingsRoutes}.ts` (mounting the two new routers plus `/settings/invoicing`).

On the client: `Pages/ledger-core/{ConfirmDialog,BackLink,CreateMenu,CustomersPage,InvoicesPage,NewInvoicePage,InvoiceDetailPage,InvoiceSettingsPage,SettingsTabs}.tsx`, plus two new test files (`ledgerCoreInvoices`, `ledgerCoreCustomers`). Edited in place: `Pages/ledger-core/{JournalsPage,JournalDetailPage,NewJournalEntryPage,AccountLedgerPage,AccountsPage,SettingsPage,LedgerCoreRoutes,LedgerCoreSidebar,money}.tsx|ts` (confirm dialogs, back links, account-name links, collapsible chart, settings tabs, the quantity/rate parsers), `Pages/AccountPage.tsx` (business-identification panel), `components/layout/AppTopBar.tsx` and `index.css` (`no-print` / `@media print`), `services/fetchServices.ts` (the invoicing types and wrappers).

**UX revision (2026-09-03, client-only — no phase renumbering, no migration, see [roadmap.md § Phase 3.5, as delivered](roadmap.md#phase-35-as-delivered)):** `/app/:appSlug` moved from a child route of `PlatformLayout` to a sibling under `ProtectedRoute` in `App.tsx` — inside an app, the suite header does not mount at all. `components/layout/AppShell.tsx` was replaced by two new files: `AppFrame.tsx` (per-app shell: loading/not-found/planned guard, the org-switch remount `key` moved here from `PlatformLayout`, renders `<Outlet/>`) and `AppTopBar.tsx` (a `h-14` bar: a small `AutoLedger` mark-and-link, the app name, then `OrgSwitcher`/org chip/email/sign-out). `PlatformLayout.tsx` now serves only `/` and `/account`. `Pages/ledger-core/LedgerCoreSidebar.tsx` became a grouped, sticky, full-height rail (`Overview`/`Bookkeeping`/`Reporting`/`Configure`) instead of a flat 6-item list; `LedgerCoreRoutes.tsx`'s `AppPages` layout changed from a `grid-cols-[13rem_1fr]` to a flex row matching the rail's own width. New components `Pages/ledger-core/{MetricTile,ProportionBar,EquationBar}.tsx` back the dashboard's four position tiles (now links into `TrialBalancePage`'s new client-side `?type=` filter — no server change), an accounting-equation bar, and revenue/expense proportion bars; `TrendChart.tsx` gained a hover readout via transparent per-month hit rects (`data-hit`, distinct from the value bars' `data-bar`). `index.css` lost `.app-shell`/`.app-shell__header`/`.app-shell__title` and the `.app-main:has(.app-shell)` rule, and gained two `.app-topbar` scoped overrides. Four tests added to `__tests__/ledgerCoreNavigation.test.tsx`; `__tests__/ledgerCoreDashboard.test.tsx` was updated to wrap `DashboardPage` in a `MemoryRouter` (needed once its tiles became `<Link>`s) and to assert `svg rect[data-bar]`/`svg rect[data-hit]` counts instead of a flat `svg rect` count. **`docs/api.md` and `docs/schema.md` are unchanged — the `?type=` filter is client-side over an already-fetched response, not a new server parameter.**

Phase 3.5 added, on the server: `db/migrations/005_ledger-core_settings.sql`, `config/currencies.ts`, `utils/fiscalYear.ts`, `schemas/ledger-core/settingsSchema.ts`, `schemas/organizationSchema.ts`, `services/ledger-core/{settingsService,dashboardService}.ts`, `controllers/ledger-core/settingsController.ts`, `routes/ledger-core/settingsRoutes.ts`, and `__tests__/{fiscalYear,ledger-core/settings,ledger-core/dashboard}.test.ts`. Edited in place: `services/organizationService.ts` (added `updateOrganization`), `controllers/organizationController.ts` and `routes/organizations.ts` (added `PATCH /`), `controllers/ledger-core/reportController.ts` and `routes/ledger-core/reportRoutes.ts` (added `dashboard`), `types/ledger-core.ts` (appended `LedgerSettings`, `DashboardSummary` and their supporting types).

On the client: `Pages/ledger-core/{LedgerCoreSidebar,LedgerSettingsContext,OnboardingPage,DashboardPage,TrendChart,SettingsPage,ReportsPage,fiscalYear}.tsx|ts`, plus three new test files (`ledgerCoreOnboarding`, `ledgerCoreDashboard`, `ledgerCoreFiscalYear`). `Pages/ledger-core/LedgerCoreRoutes.tsx` was rewritten from a tab strip into a sidebar layout with an onboarding gate. `services/fetchServices.ts` gained the settings/dashboard/organization types and wrappers.

Phase 3 — never backfilled into this delta list until now — added, on the server: `db/migrations/{002_ledger-core_accounts,003_ledger-core_backfill_chart,004_ledger-core_journals}.sql`, `utils/{money,parseBody,routeParam}.ts`, `middleware/rateLimit.ts`, `schemas/ledger-core/{accountSchema,journalSchema}.ts`, `types/ledger-core.ts`, `services/ledger-core/{accountService,journalService,reportService}.ts`, `controllers/ledger-core/{accountController,journalController,reportController}.ts`, `routes/ledger-core/{index,accountRoutes,journalRoutes,reportRoutes}.ts`, and `__tests__/{rateLimit,ledger-core/accounts,ledger-core/journals,ledger-core/reports,ledger-core/ledgerConstraints}.test.ts`.

On the client: Tailwind v4 (`vite.config.ts`, `index.css`) and `lucide-react`, `Pages/ledger-core/{LedgerCoreRoutes,AccountsPage,JournalEntryPage,TrialBalancePage,money}.tsx|ts`.

Phase 2 added, on the server: `config/apps.ts`, `types/apps.ts`, `services/appService.ts`, `controllers/appController.ts`, `routes/apps.ts`, and `__tests__/platform/apps.test.ts`.

On the client: `apps/registry.ts`, `apps/useActiveApp.ts`, `Pages/AppChooserPage.tsx`, `components/layout/AppShell.tsx`, and `__tests__/AppChooserPage.test.tsx`. Two Phase 1 files were renamed rather than added: `components/layout/AppLayout.tsx` → `PlatformLayout.tsx`, and `Pages/DashboardPage.tsx` → `Pages/AccountPage.tsx` (served at `/account` instead of `/`). **`AppShell.tsx` was itself replaced in the 2026-09-03 UX revision below — see that entry.**

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

Two kinds of file sit at a layer root. **Platform** code is identity, tenancy and the registry. **Shared infrastructure** is code more than one app consumes but no app owns — `redactionService.ts` (AP-Flow and TaxGuard AI both redact), `storageService.ts` (promoted out of AP-Flow on 2026-09-10 — see [roadmap.md](roadmap.md#phase-renumbering--2026-09-10)), `utils/levenshtein.ts`. Both stay unprefixed. Neither reads any app's tables, which is what keeps rule 16 intact: a shared service is a pure transform or a platform concern, never a back door between two apps.

`server/src/worker.ts` (Phase 7) is a **second OS process** sharing this same `src/` — it imports the identical `services/`, `db/`, `config/`, and `queue/handlers/` code the API server does, but has its own entry point, its own `pg` pool, and its own crash domain. Nothing under `services/`, `db/`, or `types/` is process-specific; only `index.ts` (API) and `worker.ts` (jobs) are.

```text
server/
├── src/
│   ├── index.ts                    ← process lifecycle: listen + graceful shutdown
│   ├── worker.ts                   ← Phase 7 — a SECOND process, same lifecycle discipline as index.ts
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
│   │   ├── redactionService.ts     ← shared infra, unprefixed — Phase 10
│   │   ├── storageService.ts       ← shared infra, unprefixed — Phase 9.5
│   │   ├── documentService.ts      ← platform, unprefixed — Phase 9.5
│   │   ├── onboardingService.ts    ← platform, unprefixed — Phase 9
│   │   ├── outboxService.ts        ← shared infra, unprefixed — Phase 7
│   │   ├── webhookService.ts       ← platform, unprefixed — Phase 7
│   │   ├── webhookDeliveryService.ts ← platform, unprefixed — Phase 7
│   │   └── ledger-core/journalService.ts
│   ├── queue/                      ← background jobs — Phase 7. Read by index.ts's app only
│   │   │                             through routes/controllers enqueuing; worker.ts is its consumer
│   │   ├── connection.ts           ← shared ioredis connection factory + health ping
│   │   ├── queues.ts               ← one typed BullMQ Queue per name, enqueue()
│   │   ├── worker.ts               ← startWorkers()/stopWorkers(), the dead-letter listener
│   │   └── handlers/
│   │       ├── integrityCheckHandler.ts
│   │       ├── outboxDrainHandler.ts
│   │       └── webhookDeliverHandler.ts
│   ├── schemas/                    ← zod request schemas — Phase 3
│   │   └── ledger-core/journalSchema.ts
│   ├── routes/
│   │   ├── index.ts                ← the /api/v1 router; every app mounts here
│   │   ├── auth.ts                 ← platform, unprefixed
│   │   ├── apps.ts                 ← platform, unprefixed
│   │   ├── webhooks.ts             ← platform, unprefixed — Phase 7
│   │   ├── webhookDeliveries.ts    ← platform, unprefixed — Phase 7
│   │   └── ledger-core/journalRoutes.ts
│   ├── middleware/
│   │   ├── auth.ts                 ← JWT verify + active-org resolution
│   │   ├── rbac.ts                 ← requireRole / requirePermission
│   │   ├── rateLimit.ts            ← Phase 3
│   │   ├── idempotency.ts          ← Phase 17
│   │   └── errorHandler.ts
│   ├── utils/
│   │   ├── apiError.ts             ← ApiError(status, message)
│   │   ├── jwt.ts
│   │   ├── validate.ts             ← hand-rolled, keeps the Phase 1 auth routes
│   │   ├── parseBody.ts            ← zod → ApiError(400) bridge — Phase 3
│   │   ├── levenshtein.ts          ← rolling-array DP — Phase 6
│   │   └── money.ts                ← toCents / formatCents, single source of truth
│   ├── db/
│   │   ├── connect.ts              ← pg Pool singleton
│   │   ├── migrate.ts              ← migration runner
│   │   ├── reset.ts                ← dev-only DB reset
│   │   ├── verifyIntegrity.ts      ← global debits == credits checker — Phase 5
│   │   └── migrations/             ← ONLY migration directory, one sequence for every app
│   ├── types/
│   │   ├── apps.ts                 ← platform, unprefixed
│   │   ├── auth.ts                 ← platform, unprefixed
│   │   ├── jobs.ts                 ← platform, unprefixed — Phase 7, queue names & payloads
│   │   ├── webhooks.ts             ← platform, unprefixed — Phase 7, event types & delivery FSM
│   │   └── ledger-core.ts
│   └── __tests__/
│       ├── platform/apps.test.ts
│       └── ledger-core/journal.test.ts
├── storage/                        ← org-scoped hash-named documents, gitignored — Phase 9.5
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
│   │   ├── useActiveApp.ts         ← resolves :appSlug against GET /apps
│   │   └── useAppBasePath.ts       ← /app/<slug> prefix for in-app links
│   ├── Pages/                      ← capital P
│   │   ├── AppChooserPage.tsx      ← "/", one card per app
│   │   ├── AccountPage.tsx         ← "/account", suite-level identity/org/session
│   │   ├── ledger-core/            ← app pages nest under Pages/<app-slug>/
│   │   └── ap-flow/
│   ├── components/
│   │   ├── ProtectedRoute.tsx
│   │   └── layout/
│   │       ├── PlatformLayout.tsx  ← suite chrome for "/" and "/account" only
│   │       ├── AppFrame.tsx        ← per-app shell, mounted at /app/:appSlug
│   │       ├── AppTopBar.tsx       ← small AutoLedger mark + app name + org/user controls
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
