# Architecture — Tenancy Model & Repository Layout

## Product structure

AutoLedger is **one product**: a full-suite accounting and bookkeeping application. Until Phase 33 it was a suite of three separately chosen apps (LedgerCore, AP-Flow, StockLedger); Phase 33 merged them into modules of one product with one sign-up, one setup wizard, one sidebar and one API namespace. See [roadmap.md § Phase 33](roadmap.md#phase-33-as-delivered). Five further apps were built and removed before that, in [Phase 29](roadmap.md#phase-29-as-delivered).

Two layers, cutting across every part of the stack:

- **Platform layer:** identity, tenancy, RBAC, onboarding state, the document vault, webhooks, AI metering, integrations, health. Built once and shared by every module.
- **Modules:** three, each owning its own code and tables.

| Module | Was | Owns | API | Code folders | Tables |
|---|---|---|---|---|---|
| **Accounting** | LedgerCore | Chart of accounts, journals, sales and purchase documents, payments, banking, FX, periods, reports, products & services | `/api/v1/<resource>` (root) | `*/accounting/`, `types/accounting.ts` | unprefixed (`accounts`, `journal_entries`, `invoices`, …), `ledger_*` |
| **Capture** (the bill inbox) | AP-Flow | OCR, PII masking, AI extraction and GL coding, the review queue, posting captured bills | `/api/v1/capture/*` | `*/capture/`, `types/capture.ts` | `ap_flow_*` |
| **Inventory** | StockLedger | Stock items, locations, movements, lots/serials, valuation, labels | `/api/v1/inventory/*` | `*/inventory/`, `types/inventory.ts` | `stock_*` |

**Table prefixes are historical and stay.** Renaming `ap_flow_*` and `stock_*` would touch every query, every audit trigger and the append-only audit history for no behavioural gain; the decision (2026-09-25) was to rename code and API, not tables.

**Why two modules keep an API prefix.** Flattening every app prefix into `/api/v1` would collide: inventory has its own `/items` and `/settings`, capture has `/documents` beside the platform vault's `/documents`. Accounting, the largest module, takes the root; the other two keep a short prefix.

**Provenance tags.** Rows that record which module produced them (`audit_logs`, `outbox_events`, `document_links`, `ai_model_calls`, `onboarding_states`, `integration_drive_files.result_app`) store a tag from `server/src/config/modules.ts`: `ledger-core`, `ap-flow`, `stock`, or `platform`. The values are the pre-Phase-33 app slugs, **frozen**: `audit_logs` is append-only, the audit triggers pass the tag as a literal argument, and one CHECK lists two of them. The API exposes the column as `module`; the client maps tags to section names (`client/src/utils/moduleLabels.ts`) and never shows a tag.

All modules share one database, one `organizations` table as the tenant boundary, and one migration sequence. The accounting module's general ledger is shared *data*: capture posts real bills through `billService`, and inventory posts through `journalService` (Phase 32), each with `source_type`/`source_id`.

**Module boundaries (rule 16).** A module is a code namespace, **not a tenancy boundary**: `org_id` from the verified access token is the only thing that scopes data access. A module never reads another module's tables. It calls the other module's services on the same transaction client. The seams are few and named: `services/inventory/documentStockService.ts` (the one inventory module accounting imports), `services/inventory/stockGlService.ts` → `journalService`, `services/capture/postingService.ts` → `billService`, and `services/integrations/driveIntakeDispatcher.ts`.

**Every module is available to every organization.** Phase 27's per-organization app selection (`organization_apps`, the `/welcome` picker, Account → Apps) was removed in Phase 33; migration `073` drops the table. Inventory is optional *in use*: until an industry template is applied, its pages show a set-up invitation.

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

### Current (verified 2026-09-11, after Phase 13)

> **Phase 33 (2026-09-25) renamed the folders this history mentions.** Server `*/ledger-core/` → `*/accounting/`, `*/ap-flow/` → `*/capture/`, `*/stock/` → `*/inventory/`; client `Pages/ledger-core|ap-flow|stock/` became section folders (`Pages/sales`, `purchases`, `inbox`, `products`, `inventory`, `banking`, `accounting`, `reports`, `settings`, `home`); `apps/`, `config/apps.ts`, `AppFrame`, `PlatformLayout` and the chooser were deleted. Paths in the historical entries below were partly rewritten to the new names. The target layout further down is current.

**Phases 14–19 are not reflected in the entries below** — this section's own snapshot dates from Phase 13 and was never refreshed through Phases 14–16 (three apps later retired in Phase 29, see [roadmap.md](roadmap.md#phase-29-as-delivered)), the Phase 18 sandbox dataset (also retired in Phase 29), or AP-Flow's automated intake. **Phase 19.3 (2026-09-17, the newest entry)** promoted Drive folder intake off AP-Flow to a platform integration, service account auth added alongside the retained OAuth path, many purposed folders per org routed through a rule-16 dispatcher: `db/migrations/053_platform_drive_integration.sql` (the guarded table rename, `auth_mode`, `integration_drive_folders`, the generic `result_app`/`result_entity_id` pair); `types/integrations.ts` (moved out of `types/capture.ts`); `services/integrations/{googleServiceAccount,googleDriveClient,driveConnectionService,driveFolderService,driveSyncService,driveIntakeDispatcher}.ts` — **the first platform-owned subdirectory under `services/`**, alongside `services/accounting/` and `services/capture/` but holding code no single app owns, the subdirectory-shaped counterpart to the unprefixed-file convention `redactionService.ts`/`storageService.ts` already establish at the layer root (see the layer-root note below); `controllers/integrations/driveController.ts`; `routes/integrations/{index,driveRoutes}.ts` (mounted at `/api/v1/integrations`, the platform block, not under any app slug); `schemas/integrations/driveSchema.ts`; `queue/handlers/integrationDrive{Sweep,Sync}Handler.ts` (renamed, on a ~60-second job scheduler with a real `last_synced_at`-filtered due query and an incremental cursor). Edited in place: `routes/capture/driveRoutes.ts` (shrunk to one legacy-alias route, the OAuth callback only); `queue/worker.ts` (the renamed scheduler plus a one-time `removeJobScheduler` for the old `ap-flow-drive-sweep-tick` id, since a Redis-resident scheduler outlives a code rename); `__tests__/helpers/factories.ts` (`resetTables()` gained the three Drive tables, absent since 19.2 — a real pre-existing gap, not new to this phase). `package.json` unchanged — no new dependency (RFC 7523's JWT-bearer grant needs only `node:crypto`). **Phases 19.1 and 19.2 (2026-09-17)** are recorded here too, so the log does not fall further behind: `db/migrations/{051_platform_ai_model_calls,052_ap-flow_drive_intake}.sql`; `types/aiUsage.ts` (`AiCallPurpose`, `AiCallProvider`, `ModelUsage`, `AiUsageSummary`); `utils/{microUsd,secretBox,pkce}.ts` (a branded `MicroUsd` money-like type distinct from `Cents`, AES-256-GCM at rest, PKCE S256 — all hand-written, zero new dependency); `config/aiPricing.ts` (a versioned, hand-verified per-model price table); `services/{aiUsageService,ap-flow/googleDriveClient,ap-flow/driveConnectionService}.ts`; `controllers/{aiUsageController,ap-flow/apFlowDriveController}.ts`; `routes/{aiUsage,ap-flow/driveRoutes}.ts` (`/ai-usage` mounted platform-level, `/drive` under `/api/v1/capture`); `queue/handlers/{apFlowDriveSweepHandler,apFlowDriveSyncHandler}.ts` (two new queues, `ap-flow-drive-sweep` on a 5-minute job scheduler); and the corresponding `__tests__/` files. Edited in place: `services/capture/modelClient.ts` (`generateStructured` now returns `{ value, usage }` instead of the bare structured object — every provider's token usage was previously parsed and discarded), `extractionService.ts`/`mappingService.ts` (an injected `onModelCall` callback so both files stay database-free while still reporting metered calls), `queue/handlers/apFlowExtractHandler.ts` (builds that callback per pipeline run). `package.json` unchanged — no new dependency either half-step.

**This delta list has a known gap: Phases 7, 8, 9, 9.5, 11, and 12 were never backfilled here** — their entries in [roadmap.md](roadmap.md) (search "as delivered") are the accurate, current record of what each added; this file's list resumes below at Phase 6, the last phase it covered before Phase 10, with Phase 13 added at the top as the most recent entry.

**Phase 13 (2026-09-11)** added a full server-and-client module for the app numbered 13 in [roadmap.md](roadmap.md) — six migrations, a pure build-engine util, its own schemas/services/controllers/routes, and a client page set under its own app-slug directory, the same one-line-per-app pattern every app in this suite follows in `config/apps.ts` and `routes/index.ts`. That app was **removed in Phase 29** (see [roadmap.md](roadmap.md#phase-29-as-delivered)) — every file this delta entry once named was deleted in that phase, so the file list is omitted here rather than left describing files that no longer exist.

**Phase 10 (2026-09-10)** added, on the server: `db/migrations/031_ap-flow_documents.sql`; `types/capture.ts` (`ApFlowDocumentStatus`, `AP_FLOW_DOCUMENT_TRANSITIONS`, OCR/PII/extraction types); `utils/{checksum,pii}.ts` (hand-written Luhn/Verhoeff, PII span detection — zero dependencies); `services/redactionService.ts` (unprefixed, shared — `rasterize`, `tesseractOcr`, `redactPage`); `services/capture/{captureDocumentService,extractionService}.ts`; `schemas/capture/{documentSchema,extractionSchema}.ts`; `controllers/capture/apFlowDocumentController.ts`; `routes/capture/{index,documentRoutes}.ts`; `queue/handlers/apFlowExtractHandler.ts`; and `__tests__/{checksum,pii,redaction,ap-flow/{documents,apFlowConstraints,extraction,pipeline}}.test.ts`. `package.json` gained four dependencies: `tesseract.js`, `sharp`, `pdfjs-dist`, `@anthropic-ai/sdk`.

Edited in place: `config/apps.ts` (`ap-flow` → `'building'`), `config/constants.ts` (`AP_FLOW_*` constants), `config/env.ts` (`ANTHROPIC_API_KEY`, optional), `types/documents.ts` (`ap-flow: ['ap_flow_document']` in `DOCUMENT_ENTITY_TYPES_BY_APP`), `types/jobs.ts` (`ap-flow-extract` queue + payload), `queue/worker.ts` (wires the new handler), `routes/index.ts` (mounts `/ap-flow`), `__tests__/helpers/factories.ts` (`resetTables()` truncates the three new tables).

On the client: `Pages/ap-flow/{ApFlowRoutes,ApFlowDocumentsPage,ApFlowDocumentDetailPage}.tsx`, `__tests__/apFlowDocuments.test.tsx`. Edited in place: `apps/registry.ts` (`'ap-flow'` entry), `services/fetchServices.ts` (AP-Flow types and wrappers). **One promotion, not an addition:** `Pages/{BackLink,ConfirmDialog,money}.tsx|ts` moved to `components/{BackLink,ConfirmDialog}.tsx` and `utils/money.ts` — AP-Flow needed all three, and importing from another app's page directory would mirror a rule-16 violation; every importer's path was rewritten in the same change, behaviour otherwise untouched (client test count unchanged by the move itself).

**Phase 6 (2026-09-04)** added, on the server: `db/migrations/019_ledger-core_bank_reconciliation.sql`; `utils/{csv,dateParse,levenshtein,matchScore}.ts` (all hand-written, zero new dependencies — a two-pass CSV state machine, an `ISO`/`DMY`/`MDY` date parser, a rolling-array Levenshtein distance, and the 40/30/30 confidence-scoring engine); `schemas/accounting/bankSchema.ts`; `services/accounting/{bankImportService,bankMatchService}.ts`; `controllers/accounting/{bankImportController,bankTransactionController}.ts`; `routes/accounting/{bankImportRoutes,bankTransactionRoutes}.ts`; and `__tests__/{csv,dateParse,levenshtein,matchScore}.test.ts` plus `__tests__/accounting/{bankConstraints,bankImports,bankMatching,bankReconciliation}.test.ts` and `__tests__/helpers/bankFixture.ts`. `package.json` unchanged — no new dependency.

Edited in place: `utils/money.ts` (added `parseMoneyText`, untrusted-text → cents with no intermediate float), `config/constants.ts` (added `MAX_CSV_CHARS`), `services/accounting/paymentService.ts` (`createPayment`/`voidPayment` split into `createPaymentOnClient`/`voidPaymentOnClient`, mirroring `journalService`'s existing split, so `bankMatchService` can post or void a payment inside its own transaction), `services/accounting/reportService.ts` (added `bankReconciliation`), `controllers/accounting/reportController.ts` and `routes/accounting/reportRoutes.ts` (added `bankReconciliation` / `GET /bank-reconciliation`), `routes/accounting/index.ts` (mounts the two new routers), `types/accounting.ts` (`BankTransactionStatus`, `BANK_TRANSACTION_TRANSITIONS`, `BankStatementImport`, `BankTransaction`, `BankMatchSuggestion`, `BankReconciliationReport`), `__tests__/helpers/factories.ts` (`resetTables()` truncates the three new tables).

On the client: `Pages/{BankImportPage,BankTransactionsPage,BankReconciliationPage,MatchScoreBadge}.tsx` (new), plus three new test files (`ledgerCoreBankImport`, `ledgerCoreBankTransactions`, `ledgerCoreBankReconciliation`). Edited in place: `services/fetchServices.ts` (the bank-reconciliation types and wrappers), `Pages/{LedgerCoreRoutes,LedgerCoreSidebar}.tsx` (the `bank`/`bank/import`/`bank/reconciliation` routes and a new "Banking" rail group).

**Phase 5 (2026-09-04)** added, on the server: `db/migrations/{017_platform_audit_logs,018_platform_audit_triggers}.sql`, `db/integrity.ts`, `db/transaction.ts` (`beginTransaction`/`withTransaction`, the new sanctioned entry point for every write transaction), `scripts/verifyIntegrity.ts`, `utils/requestContext.ts` (`AsyncLocalStorage`-backed `RequestContext`), `middleware/requestContext.ts` (`attachRequestContext`, mounted first in `app.ts`, before `cors`), `types/audit.ts`, `services/auditService.ts`, `controllers/auditController.ts`, `routes/auditLogs.ts` (mounted platform-level at `/api/v1/audit-logs`, not under any app slug), and `__tests__/{integrity,platform/auditTrail,platform/auditActor,platform/auditLogs}.test.ts`. `package.json` gained the `verify:integrity` script; no new dependency — `AsyncLocalStorage` is `node:async_hooks`.

Edited in place: `middleware/auth.ts` (`authenticate` now fills `userId`/`orgId` onto the request context once the token verifies); every service holding a hand-rolled transaction (`authService`, `organizationService`, `ledger-core/{accountService,customerService,vendorService,invoiceSettingsService,settingsService,invoiceService,billService,journalService,paymentService,fiscalPeriodService}`) — the 20 bare `client.query('BEGIN')` call sites became `beginTransaction(client)`, and the 10 single-statement writes that previously ran on `pool` directly (each service's `create`/`update`/`delete`) now run inside `withTransaction(...)`, so every write has a transaction for the audit trigger's session-variable context to attach to (guardrails rule 5, extended); `routes/index.ts` (mounts `auditRoutes`).

On the client: `Pages/AuditLogPage.tsx` (new), `Pages/{LedgerCoreRoutes,LedgerCoreSidebar}.tsx` (the `audit` route and rail entry), `services/fetchServices.ts` (`AuditLogEntry`/`AuditLogDetail`/`getAuditLogs`/`getAuditLogDetail`), plus `__tests__/ledgerCoreAuditLog.test.tsx`.

**Phase 3.8 (2026-09-04)** added, on the server: `db/migrations/{006_platform_organization_tax_ids,007_ledger-core_invoice_settings,008_ledger-core_customers,009_ledger-core_invoices,010_ledger-core_invoice_lines_org_index}.sql`, `schemas/accounting/{customerSchema,invoiceSchema,invoiceSettingsSchema}.ts`, `services/accounting/{customerService,invoiceService,invoiceSettingsService}.ts`, `controllers/accounting/{customerController,invoiceController,invoiceSettingsController}.ts`, `routes/accounting/{customerRoutes,invoiceRoutes}.ts`, and `__tests__/{organizations,ledger-core/customers,ledger-core/invoices,ledger-core/invoiceConstraints,ledger-core/invoiceSettings}.test.ts`. Edited in place: `services/accounting/journalService.ts` (added `createEntryOnClient`/`reverseEntryOnClient`, the transaction-client variants `invoiceService` posts through), `utils/money.ts` (added `scaleCents`), `types/{auth,ledger-core}.ts` (organization tax fields; `Customer`, `Invoice*`, `InvoiceSettings`, the `INVOICE_STATUSES`/`INVOICE_TRANSITIONS` FSM), `services/organizationService.ts` and `schemas/organizationSchema.ts` (tax/business number fields on `updateOrganization`), `routes/accounting/{index,settingsRoutes}.ts` (mounting the two new routers plus `/settings/invoicing`).

On the client: `Pages/{ConfirmDialog,BackLink,CreateMenu,CustomersPage,InvoicesPage,NewInvoicePage,InvoiceDetailPage,InvoiceSettingsPage,SettingsTabs}.tsx`, plus two new test files (`ledgerCoreInvoices`, `ledgerCoreCustomers`). Edited in place: `Pages/{JournalsPage,JournalDetailPage,NewJournalEntryPage,AccountLedgerPage,AccountsPage,SettingsPage,LedgerCoreRoutes,LedgerCoreSidebar,money}.tsx|ts` (confirm dialogs, back links, account-name links, collapsible chart, settings tabs, the quantity/rate parsers), `Pages/AccountPage.tsx` (business-identification panel), `components/layout/AppTopBar.tsx` and `index.css` (`no-print` / `@media print`), `services/fetchServices.ts` (the invoicing types and wrappers).

**UX revision (2026-09-03, client-only — no phase renumbering, no migration, see [roadmap.md § Phase 3.5, as delivered](roadmap.md#phase-35-as-delivered)):** `/app/:appSlug` moved from a child route of `PlatformLayout` to a sibling under `ProtectedRoute` in `App.tsx` — inside an app, the suite header does not mount at all. `components/layout/AppShell.tsx` was replaced by two new files: `AppFrame.tsx` (per-app shell: loading/not-found/planned guard, the org-switch remount `key` moved here from `PlatformLayout`, renders `<Outlet/>`) and `AppTopBar.tsx` (a `h-14` bar: a small `AutoLedger` mark-and-link, the app name, then `OrgSwitcher`/org chip/email/sign-out). `PlatformLayout.tsx` now serves only `/` and `/account`. `Pages/LedgerCoreSidebar.tsx` became a grouped, sticky, full-height rail (`Overview`/`Bookkeeping`/`Reporting`/`Configure`) instead of a flat 6-item list; `LedgerCoreRoutes.tsx`'s `AppPages` layout changed from a `grid-cols-[13rem_1fr]` to a flex row matching the rail's own width. New components `Pages/{MetricTile,ProportionBar,EquationBar}.tsx` back the dashboard's four position tiles (now links into `TrialBalancePage`'s new client-side `?type=` filter — no server change), an accounting-equation bar, and revenue/expense proportion bars; `TrendChart.tsx` gained a hover readout via transparent per-month hit rects (`data-hit`, distinct from the value bars' `data-bar`). `index.css` lost `.app-shell`/`.app-shell__header`/`.app-shell__title` and the `.app-main:has(.app-shell)` rule, and gained two `.app-topbar` scoped overrides. Four tests added to `__tests__/ledgerCoreNavigation.test.tsx`; `__tests__/ledgerCoreDashboard.test.tsx` was updated to wrap `DashboardPage` in a `MemoryRouter` (needed once its tiles became `<Link>`s) and to assert `svg rect[data-bar]`/`svg rect[data-hit]` counts instead of a flat `svg rect` count. **`docs/api.md` and `docs/schema.md` are unchanged — the `?type=` filter is client-side over an already-fetched response, not a new server parameter.**

Phase 3.5 added, on the server: `db/migrations/005_ledger-core_settings.sql`, `config/currencies.ts`, `utils/fiscalYear.ts`, `schemas/accounting/settingsSchema.ts`, `schemas/organizationSchema.ts`, `services/accounting/{settingsService,dashboardService}.ts`, `controllers/accounting/settingsController.ts`, `routes/accounting/settingsRoutes.ts`, and `__tests__/{fiscalYear,ledger-core/settings,ledger-core/dashboard}.test.ts`. Edited in place: `services/organizationService.ts` (added `updateOrganization`), `controllers/organizationController.ts` and `routes/organizations.ts` (added `PATCH /`), `controllers/accounting/reportController.ts` and `routes/accounting/reportRoutes.ts` (added `dashboard`), `types/accounting.ts` (appended `LedgerSettings`, `DashboardSummary` and their supporting types).

On the client: `Pages/{LedgerCoreSidebar,LedgerSettingsContext,OnboardingPage,DashboardPage,TrendChart,SettingsPage,ReportsPage,fiscalYear}.tsx|ts`, plus three new test files (`ledgerCoreOnboarding`, `ledgerCoreDashboard`, `ledgerCoreFiscalYear`). `Pages/LedgerCoreRoutes.tsx` was rewritten from a tab strip into a sidebar layout with an onboarding gate. `services/fetchServices.ts` gained the settings/dashboard/organization types and wrappers.

Phase 3 — never backfilled into this delta list until now — added, on the server: `db/migrations/{002_ledger-core_accounts,003_ledger-core_backfill_chart,004_ledger-core_journals}.sql`, `utils/{money,parseBody,routeParam}.ts`, `middleware/rateLimit.ts`, `schemas/accounting/{accountSchema,journalSchema}.ts`, `types/accounting.ts`, `services/accounting/{accountService,journalService,reportService}.ts`, `controllers/accounting/{accountController,journalController,reportController}.ts`, `routes/accounting/{index,accountRoutes,journalRoutes,reportRoutes}.ts`, and `__tests__/{rateLimit,ledger-core/accounts,ledger-core/journals,ledger-core/reports,ledger-core/ledgerConstraints}.test.ts`.

On the client: Tailwind v4 (`vite.config.ts`, `index.css`) and `lucide-react`, `Pages/{LedgerCoreRoutes,AccountsPage,JournalEntryPage,TrialBalancePage,money}.tsx|ts`.

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

Layer-first, with a **module** subfolder inside each layer (`accounting/`, `capture/`, `inventory/`); platform code stays at the layer root, unprefixed. Do **not** invent a parallel `src/modules/` tree on the server.

Two kinds of file sit at a layer root. **Platform** code is identity, tenancy, onboarding and the vault. **Shared infrastructure** is code more than one module consumes but no module owns — `redactionService.ts`/`utils/pii.ts`, `storageService.ts`, `utils/levenshtein.ts`. Neither reads any module's tables, which is what keeps rule 16 intact: a shared service is a pure transform or a platform concern, never a back door between two modules.

`services/integrations/` (Phase 19.3) is shared infrastructure at subdirectory scale: an integration has no module of its own, and its dispatcher's whole job is calling *into* a module's service, never reading its tables.

`server/src/worker.ts` (Phase 7) is a **second OS process** sharing this same `src/` — the identical `services/`, `db/`, `config/` and `queue/handlers/` code, with its own entry point, `pg` pool and crash domain.

```text
server/
├── src/
│   ├── index.ts                    ← process lifecycle: listen + graceful shutdown
│   ├── worker.ts                   ← Phase 7 — a SECOND process, same lifecycle discipline
│   ├── app.ts                      ← createApp(): middleware + route mounting
│   ├── config/
│   │   ├── env.ts                  ← fail-fast env parsing, the only reader of process.env
│   │   ├── constants.ts            ← API_VERSION and other cross-layer values
│   │   ├── modules.ts              ← Phase 33 — MODULE_TAGS, the frozen provenance tags
│   │   └── inventoryIndustryProfiles.ts
│   ├── controllers/                ← thin HTTP adapters, zero SQL
│   │   ├── authController.ts       ← platform, unprefixed
│   │   ├── accounting/ · capture/ · inventory/ · integrations/
│   ├── services/                   ← ALL DB logic lives here
│   │   ├── authService.ts, documentService.ts, onboardingService.ts, …  ← platform, unprefixed
│   │   ├── redactionService.ts, storageService.ts, outboxService.ts    ← shared infra
│   │   ├── accounting/             ← journalService, invoiceService, billService, …
│   │   ├── capture/                ← captureDocumentService, extractionService, postingService, …
│   │   ├── inventory/              ← itemService, movementService, documentStockService, stockGlService, …
│   │   └── integrations/           ← Drive connection, folders, sync, dispatcher
│   ├── queue/                      ← background jobs — Phase 7
│   │   └── handlers/               ← integrityCheck, outboxDrain, webhookDeliver, captureExtract, integrationDrive*
│   ├── schemas/                    ← zod request schemas: accounting/ · capture/ · inventory/ · integrations/
│   ├── routes/
│   │   ├── index.ts                ← the /api/v1 router: platform routes, then /inventory, /capture, then accounting at /
│   │   ├── auth.ts, organizations.ts, onboarding.ts, documents.ts, …  ← platform, unprefixed
│   │   └── accounting/ · capture/ · inventory/ · integrations/
│   ├── middleware/                 ← auth, rbac, rateLimit, upload, requestContext, errorHandler
│   ├── utils/                      ← apiError, jwt, parseBody, money, levenshtein, …
│   ├── db/
│   │   ├── connect.ts · migrate.ts · reset.ts · integrity.ts
│   │   └── migrations/             ← ONLY migration directory, one sequence for every module
│   ├── types/
│   │   ├── auth.ts, jobs.ts, webhooks.ts, onboarding.ts, documents.ts, …  ← platform
│   │   └── accounting.ts · capture.ts · inventory.ts
│   └── __tests__/                  ← platform/ · accounting/ · capture/ · inventory/ · integrations/ · unit files at the root
├── storage/                        ← org-scoped hash-named documents, gitignored — Phase 9.5
├── tsconfig.json · tsconfig.build.json · vitest.config.ts · package.json

client/
├── src/
│   ├── main.tsx                    ← wraps <App/> in <ThemeProvider/>
│   ├── App.tsx                     ← router + providers; /login, /register, then AppShell
│   ├── routes/                     ← Phase 33
│   │   ├── ProductRoutes.tsx       ← every product page, flat absolute routes
│   │   ├── SetupGate.tsx           ← onboarding gate (soft when skipped) + /onboarding
│   │   ├── WorkspaceLayout.tsx     ← sidebar + page
│   │   ├── InventoryGate.tsx       ← "set up inventory" until a template is applied
│   │   ├── LegacyAppRedirect.tsx   ← /app/<slug>/... → new URLs, permanently (printed QR labels)
│   │   └── paths.ts                ← INVENTORY_BASE, INBOX_BASE
│   ├── context/                    ← AuthContext, OrgContext, ThemeContext, LedgerSettingsContext
│   ├── Pages/                      ← capital P; one folder per sidebar section
│   │   ├── home/                   ← DashboardPage, OnboardingPage, SetupChecklist, InboxSummaryCard
│   │   ├── sales/ · purchases/ · inbox/ · products/ · inventory/ · banking/ · accounting/ · reports/
│   │   ├── settings/               ← SettingsHubPage + every settings page (accounting, sales, inventory, bill inbox, connections, audit)
│   │   └── AccountPage.tsx, DocumentsPage.tsx, NotFoundPage.tsx, auth/
│   ├── components/
│   │   ├── ui/                     ← Menu, TabBar, PageHeader, StatTile, MetricTile, EmptyState, Skeleton, formClasses
│   │   └── layout/                 ← AppShell, nav.ts, Sidebar, AppSidebar, AppTopBar, AppFooter, CommandPalette, CreateMenu, ShellContext, OrgSwitcher
│   ├── services/fetchServices.ts
│   └── utils/                      ← money, quantity, moduleLabels, fetchWithAutoRefresh, …
├── index.html                      ← inline no-flash theme script (Phase 31)
├── vite.config.ts
└── package.json
```

No `Dockerfile` or `entrypoint.sh` in either tree — the application processes run on the host during development, and a production image is deployment work. See [development.md](development.md#why-not-full-docker).

---

## Module delivery order

Each new module lands in this order:

**migration(s) → types → service(s) → controller(s) → routes → mount in `routes/index.ts` → tests → docs → client pages**

A new accounting resource adds one `router.use('/<resource>', …)` line to `server/src/routes/accounting/index.ts`; an inventory or capture resource goes in that module's `index.ts`. Check a new root resource name against the platform routes and the other modules first — the root namespace is shared. Nothing mounts directly on the app — `app.ts` knows only about the single versioned router. Frontend pages go under the `client/src/Pages/<section>/` folder of the sidebar section they appear in, with a route in `client/src/routes/ProductRoutes.tsx` and, if it is navigable, an entry in `components/layout/nav.ts`.

In the same change, update: the status in `CLAUDE.md`, [roadmap.md](roadmap.md), [api.md](api.md), and [schema.md](schema.md).
