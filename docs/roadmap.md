# Build Roadmap & App Map

AutoLedger is a suite, not a single application. Phases 0–1 built the platform every app in the suite shares — identity, tenancy, RBAC. Phase 2 added the platform layer that turns "one app" into "a chooser over several apps." From Phase 3 onward, each phase belongs to exactly one app.

Phases are sequential. Where a **Gate** is listed, do not start the gated work first — ask before reordering.

| Phase | Scope | Gate |
|---|---|---|
| **0 ✅ done** | Scaffold — see [Phase 0, as delivered](#phase-0-as-delivered) below | Blocks everything |
| **1 ✅ done** | Identity + tenancy — see [Phase 1, as delivered](#phase-1-as-delivered) below | Blocks everything below |
| **2 ✅ done** | Platform: app registry, chooser, app-scoped routing — see [Phase 2, as delivered](#phase-2-as-delivered) below | Blocks 3+ |
| **3 ✅ done** | LedgerCore — GL core — see [Phase 3, as delivered](#phase-3-as-delivered) below | Blocks 4+ |
| **4 ✅ done** | LedgerCore — live statements: P&L, balance sheet, fiscal periods with close/lock — see [Phase 4, as delivered](#phase-4-as-delivered) below | Needs 3 |
| **5 ✅ done** | Shared — CDC audit trail: `audit_logs` JSONB table, `OLD`/`NEW` snapshot triggers on every financial table across every app, actor + IP captured via `SET LOCAL`, plus the `verify:integrity` checker — see [Phase 5, as delivered](#phase-5-as-delivered) below | Blocked compliance claims until delivered |
| **6 ✅ done** | LedgerCore — bank reconciliation: CSV ingestion, the 40/30/30 confidence engine, ≥85 auto-reconcile, interactive approval queue — see [Phase 6, as delivered](#phase-6-as-delivered) below | Needs 4 |
| **7 ✅ done** | Shared — background jobs: `bullmq` + `ioredis`, Redis healthcheck, worker process, retry/DLQ policy, **plus financial-event webhooks** — see [Phase 7, as delivered](#phase-7-as-delivered) below | Blocks 9, 10, 15, 16 |
| **8** | LedgerCore — multi-currency FX engine: `fx_rates` table, realized FX gain/loss on settlement, period-end unrealized revaluation | Needs 3, 7 |
| **9** | LedgerCore — QuickBooks Online sync: OAuth 2.0, per-org token storage, journal entry push | Needs 7 |
| **10** | AP-Flow — capture & extraction: upload, hash-addressed storage, local OCR with bounding boxes, **PII pixel masking**, Claude Vision → structured JSON with per-field confidence. Produces a draft; posts nothing | Needs 7 |
| **11** | AP-Flow — mapping, review & posting: vendor→COA classification from history, tax/VAT split, FX at invoice date, review-queue UI, one-click post into LedgerCore with document-hash stamping, COGS tracking | Needs 5, 8, 10 |
| **12** | FP&A Engine — 3-statement financial linking, scenario modeling, cash runway forecasting | Needs 4 |
| **13** | ForecasterPro — driver-based rolling forecasting, headcount planning, zero-based budgeting | Needs 12 |
| **14** | UnitEcon — cohort retention matrices, LTV/CAC ratios, Price-Volume-Mix variance | Needs 4 |
| **15** | BoardDeck Automator — monthly close automation, BvA variance, automated `.pptx` deck generation | Needs 7, 13 |
| **16** | TaxGuard AI — tax act parsing, RAG over `pgvector`, PII redaction | Needs 7 |

**Integration tests are not a phase.** They start in Phase 1 and grow with every module — see [testing.md](testing.md).

Two apps have a spec detailed enough to warrant its own file: [ledger-core.md](ledger-core.md) (Phases 3–4, 6, 8–9) and [ap-flow.md](ap-flow.md) (Phases 10–11). Each carries the full feature scope, a checkbox ladder, and per-phase acceptance criteria. This table stays the index; those files hold the detail.

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

**Known gaps, deliberate:** no email verification (columns exist, nothing writes them); a revoked membership stays effective for up to 15 minutes, which is the trade the short access-token TTL buys ([architecture.md](architecture.md)).

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

**LLM integration is no longer out of scope.** The previous ruling ("Do not add an LLM dependency, API key, or provider SDK without an explicit decision recorded here first") is reversed by this entry: TaxGuard AI (Phase 13 at the time, **now Phase 16**) requires RAG over `pgvector` and an LLM/embeddings SDK. The decision is recorded here, as that ruling required. It was widened to a second app on 2026-09-01 — see [Phase renumbering](#phase-renumbering--2026-09-01).

**No migration in this phase.** The app registry is a static code list, not a database table — there is no per-org entitlement to persist yet. If entitlement becomes real (e.g. a paid tier that unlocks specific apps), it becomes a migration then, not now.

---

## Phase 3, as delivered

LedgerCore has a general ledger. You can see a seeded chart of accounts, post a balanced journal entry, reverse it, and read a trial balance that proves the books balance — and an unbalanced entry cannot be written by *anything*, including raw SQL.

**Landed:**

- `002_ledger-core_accounts.sql` — `accounts` with a self-referencing `parent_id` (the chart is a tree), `is_postable` separating header rollups from leaves, `UNIQUE (org_id, code)`
- `003_ledger-core_backfill_chart.sql` — the default chart for every organization that had none, paying the backfill debt Phases 1–2 accrued
- `004_ledger-core_journals.sql` — `journal_entries` and `ledger_lines`, plus **five triggers**: two `DEFERRABLE INITIALLY DEFERRED` constraint triggers enforcing the balance invariant at `COMMIT`, a `BEFORE INSERT` guard rejecting postings to header accounts or to another tenant's account, and two `BEFORE UPDATE OR DELETE` triggers making posted rows immutable with SQLSTATE `0A000`
- The **44-account default chart** (34 postable leaves, 10 headers), seeded inside `register`'s existing transaction and including the tax and FX accounts Phases 8 and 11 will need — so neither inherits a backfill of its own
- `utils/money.ts` — the branded `Cents` type with a checked constructor, and the `pg` `BIGINT`-string parser. `as Cents` appears in that file and nowhere else
- `zod` adopted for LedgerCore, with a new `src/schemas/` layer and `utils/parseBody.ts` bridging zod errors to `ApiError(400)`. Phase 1's hand-rolled `utils/validate.ts` still serves `/auth` — an addition, not a rewrite
- `/api/v1/ledger-core` — accounts (4 routes), journals (4, including `POST /:id/reverse`), reports (trial balance). See [api.md](api.md)
- `express-rate-limit` on `/auth/login` and `/auth/register` — **debt carried since Phase 1, now paid**
- Client: Tailwind v4 + `lucide-react`, and LedgerCore's first three pages under `Pages/ledger-core/`
- **191 server tests** (up from 95) and **27 client tests** (up from 15), including `__tests__/ledger-core/ledgerConstraints.test.ts`, which bypasses the service entirely and asserts the *database* rejects unbalanced and mutated rows

**Deliberately changed from the original Phase 3 scope:**

| Planned | Actual | Why |
|---|---|---|
| `journal_entries.updated_at` | Dropped | The row is immutable, so the column could only ever equal `created_at`. Dead scaffolding implying a capability the table does not have |
| `journal_entries.org_id ON DELETE CASCADE` | `ON DELETE RESTRICT` | You cannot delete an organization that has posted journals. Correct accounting, and the only way cascade and the immutability trigger can coexist — a cascade would abort inside the trigger instead of failing cleanly at the parent |
| Currency columns in Phase 8 with the FX engine | Written from Phase 3 | The *engine* can wait; the *columns* cannot. Once a line exists without its native amount and rate, that information is unrecoverable |
| One trigger enforcing the balance | Two | A trigger on `ledger_lines` never fires for an entry with **no** lines, and "debits equal credits" is vacuously true of nothing. A second deferred trigger on `journal_entries` closes it |
| `MIGRATION_FILENAME` regex unchanged | Widened to allow `-` | `/^(\d{3})_[a-z0-9_]+\.sql$/` rejected `002_ledger-core_accounts.sql` — the app-tagged convention [schema.md](schema.md) mandates. Found before writing any migration |
| `pg` default `DATE` parsing | Global type parser returning a string | `pg` parses `DATE` at local midnight; `.toISOString()` then shifted every accounting date back a day at UTC+05:30. A `DATE` is a calendar fact, not an instant |

**Known gaps, deliberate:** the trial balance is the only report — P&L and balance sheet are Phase 4, along with fiscal periods, so nothing yet prevents posting into a closed month. Rate limiting is per-IP only, which a distributed attacker defeats; per-account tracking needs a shared store, which Redis (available since Phase 7) could back, but the limiter has not been rewired to use it — see [Phase 7, as delivered](#phase-7-as-delivered)'s "Deliberately not built" for why. The FX columns exist but every line is written at rate 1 in the org's base currency until Phase 8. `created_by` is recorded on every entry but there was no audit trail yet at this point in the build — that gap is closed by [Phase 5, as delivered](#phase-5-as-delivered), below.

---

## Phase 3.5, as delivered

LedgerCore has a front door. A user who registers and picks LedgerCore for the first time is walked through a one-time onboarding wizard — workspace name, legal name, industry, base currency, fiscal year start, books start date, an optional cash account — and lands on a dashboard instead of a bare chart of accounts. The chart-of-accounts/journals/trial-balance tab strip is replaced by a sidebar with room for Reports and Settings.

**This is a half-step, not a renumbering.** It slots between the delivered Phase 3 and the unstarted Phase 4, and it changes no phase number anywhere in this document. Phase 4 is unaffected and unstarted: **no `fiscal_periods` table, no period close/lock, no posting-into-a-closed-period guard, no P&L, no balance sheet exist after this phase.** This phase stores a fiscal-year *setting*, consumed by report queries in application code — it creates no period rows and enforces no lock.

**Landed:**

- `005_ledger-core_settings.sql` — `ledger_settings` (one row per organization, keyed by `org_id`), and a composite `UNIQUE (org_id, id)` on `accounts` so `ledger_settings.cash_account_id` carries a **composite FK** `(org_id, cash_account_id) → accounts (org_id, id)` — a cross-tenant cash account is rejected by the database, not only by a service check. See [study/postgresql/composite-foreign-keys-for-tenancy.md](../study/postgresql/composite-foreign-keys-for-tenancy.md)
- `settingsService` — `getSettings` (a missing row means "not onboarded," never a 404), `completeOnboarding` (one transaction, idempotent — resubmitting overwrites rather than erroring), `updateSettings` (refuses to write until onboarding has completed once)
- `organizationService.updateOrganization` — new, takes an optional transaction client so `completeOnboarding` can write the organization's name and base currency in the same transaction as its LedgerCore settings
- **The base-currency lock**: changing `baseCurrency` once any `ledger_lines` row exists is rejected with `422` — those rows are immutable and stamped with their currency at write time, so a retroactive change would silently invalidate every posted line
- `dashboardService.dashboardSummary` — position (assets/liabilities/equity/cash/`currentEarningsCents`/`equationHolds`), year-to-date and month-to-date performance, a 6-point gap-filled trend, recent entries, and the integrity check, aggregated from raw `ledger_lines` on every request via `FILTER`-clause aggregates and a `generate_series` scaffold — see [study/postgresql/aggregating-a-ledger.md](../study/postgresql/aggregating-a-ledger.md). **No summary table**, same rule as the trial balance
- `/api/v1/ledger-core/settings` (3 routes) and `GET /api/v1/ledger-core/reports/dashboard`; `PATCH /api/v1/organizations` (new, platform-layer — organization name and base currency are platform fields, not LedgerCore ones)
- Client: `LedgerCoreSidebar`, `LedgerSettingsContext`, an onboarding wizard (`OnboardingPage`, 3 steps, discriminated-union step state), `DashboardPage` with a hand-rolled inline-SVG `TrendChart` (no charting library — rule 14), `SettingsPage`, and `ReportsPage` (trial balance live, P&L/balance sheet honestly marked "Phase 4," not linked to a stub)
- **230 server tests** (up from 191) and **41 client tests** (up from 27), including both modules' cross-tenant isolation suites

**Deliberately changed from the original plan:**

| Planned | Actual | Why |
|---|---|---|
| `ON DELETE SET NULL` on the composite cash-account FK | `ON DELETE RESTRICT` | A composite FK's `SET NULL` nulls every column in the key, including `org_id` — this table's `NOT NULL` primary key. `RESTRICT` never fires in practice since `accounts` rows are never deleted |
| Onboarding fields on `ledger_settings` | `organizationName`/`baseCurrency` stay on `organizations`, edited via `PATCH /organizations` | Both are platform fields per the platform/app split ([architecture.md](architecture.md#suite-structure)); the wizard still collects them in one UI, but `completeOnboarding` writes them through `organizationService` on the same transaction client |

**Known gaps, deliberate:** the dashboard's `position` is not the Phase 4 balance sheet — `equationHolds` checks `assets = liabilities + equity + currentEarningsCents` rather than exposing a true balance sheet, because current-period earnings have to be folded in by hand until Phase 4's live statements land. The cash tile is `null` until an organization configures a cash account; nothing infers one by account code. Base currency can only ever be locked, never unlocked — there is no path back to "no postings yet."

**UX revision, 2026-09-03:** the suite header no longer wraps an app; `AppShell` became `AppFrame` + `AppTopBar`, the LedgerCore sidebar became a grouped full-height rail, the dashboard's position figures became links into a client-side `?type=` trial-balance filter, and the trend chart gained a hover readout. **No phase renumbering; Phase 4 remains unstarted.** See [architecture.md § Current](architecture.md#current-verified-2026-09-03-after-the-ledgercore-shelldashboard-ux-revision) for the file-level delta.

---

## Phase 3.6, as delivered

A second half-step, like 3.5. It slots between the delivered Phase 3.5 and the unstarted Phase 4, and changes no phase number anywhere in this document. **No migration** — the journal register, the account ledger, and the chart-wide balance rollup are all served by tables and indexes Phase 3 already built.

**Landed:** `GET /ledger-core/journals` gains server-side filters (`from`/`to`/`accountId`/`sourceType`/`q`) with a shared count/page predicate builder and a stable pagination tiebreaker; each entry now carries the posting user's name/email, a `reversedByEntryId` pointer, and both totals. `GET /ledger-core/accounts/:id/ledger` — a postable account's opening balance, running-balance transaction history (a window function over the full filtered set, correct across pages), period totals, and closing balance; header accounts are refused with `422`. `GET /ledger-core/accounts/balances` — own and subtree-rollup balance per account via a descendant-walking recursive CTE. Client: the former single journal-entry page split into a register, a posting page, and a detail page; a new account-ledger page; balances and ledger links added to the chart of accounts. Full detail and acceptance criteria: [ledger-core.md § Phase 3.6](ledger-core.md#phase-36--journal-register--account-ledger).

**Known gaps, deliberate:** no sequential entry number — the register shows the first 8 characters of the entry's uuid. A header account's balance rolls up but its transaction list does not; there is no rolled-up ledger view for a header. No CSV/PDF export.

---

## Phase 3.7, as delivered

A third half-step, client-only. **No migration, no new server route, no new dependency** — every endpoint this phase's UI calls already existed after Phase 3.6.

**Landed:** the journal register (`JournalsPage`) gains a per-row Actions column — View, Duplicate, Reverse — replacing the date cell's link; Reverse is offered only on an entry that is neither a reversal nor already reversed, mirroring `JournalDetailPage`'s existing `canReverse` rule exactly, since the two surfaces must agree about which entries are correctable. There is still no edit and never will be — rule 6 and migration 004's `BEFORE UPDATE OR DELETE` trigger both forbid it — so Duplicate is the substitute: it opens the post form at `journals/new?copyFrom=<id>`, which seeds the date, description and lines from the copied entry once (an effect with a `seeded` latch, not a live binding — see [study/react/routing-nested-and-dynamic-segments.md § one-shot seed](../study/react/routing-nested-and-dynamic-segments.md#a-query-parameter-as-a-one-shot-seed-not-a-source-of-truth)) and then lets the form behave exactly as if typed from blank. The trial balance's account name and the account ledger's Reference cell are both now links — into that account's ledger, and into the journal entry a line was posted in, respectively — closing the navigation loop chart → ledger → entry → account. The chart of accounts gained a create form (`NewAccountForm`, a new component) reachable from a header button and, when the chart is empty, a dedicated "Create the first account" prompt; it posts to the already-existing `POST /ledger-core/accounts` and the chart refetches on success rather than splicing the new account into local tree state.

**Deliberately not built:** client-side role gating on any of the above. Every action is shown to every member; the server's `requireRole` is the only enforcement, and a `403` renders inline. Adding gating later means threading `OrgProvider` through several presently-provider-free test files — a deferred cost, not an oversight.

**Tests:** 13 cases added to `ledgerCoreJournals.test.tsx` (register actions, `?copyFrom=` seeding), 1 to `ledgerCoreAccountLedger.test.tsx`, a new `ledgerCoreTrialBalance.test.tsx` (2 cases), and 5 to `ledgerCoreAccounts.test.tsx` — 79 client tests total. Server suite unchanged at 280, confirming no server code moved.

---

## Phase 3.8, as delivered

A fourth half-step, following the 3.5/3.6/3.7 lineage. **Renumbers nothing** — Phase 4 (live statements, fiscal periods, the AR/AP subledger *report*) remains entirely unstarted after this phase. Two pieces of scope, planned and delivered together: the navigation/confirmation fixes the 3.5–3.7 UI had been missing, and LedgerCore's first accounts-receivable source document, sales invoicing.

**Navigation & confirmation (client-only):** reversing a journal entry — from the register or the detail page — now opens a `ConfirmDialog` (a hand-rolled `role="dialog"` component, not `window.confirm`, which is untestable in jsdom and blocks the event loop) before the API call fires; the same dialog gates issuing and voiding an invoice. Every drill-down page (`JournalDetailPage`, `NewJournalEntryPage`, `AccountLedgerPage`, `InvoiceDetailPage`, `NewInvoicePage`) gained a `BackLink` as its first element. A journal line's account **name**, not only its code, now links into that account's ledger. The chart of accounts' header rows are collapsible (`ChevronDown` toggle, `aria-expanded`), starting fully expanded.

**Migrations `006`–`010`:** `006` adds `organizations.tax_number`/`business_number` (platform fields, edited via the existing `PATCH /organizations`). `007` adds `ledger_invoice_settings` (numbering, defaults, branding — no seed row, same "absence means unconfigured" posture as `ledger_settings`). `008` adds `customers`. `009` adds `invoices`/`invoice_lines` plus two immutability triggers — one absolute (`invoice_lines`, once its parent leaves `DRAFT`), one with a single carve-out (`invoices`' `ISSUED -> VOID` transition, verified by a `to_jsonb` row-diff so only `status`/`voided_at`/`void_journal_entry_id` may move). `010` is a same-phase guardrail-review follow-up adding the `(org_id, invoice_id)` scope index `invoice_lines` was missing. Full detail: [schema.md § Phase 3.8](schema.md#phase-38--navigation-fixes--sales-invoicing-ledgercore--applied).

**`journalService` gained `createEntryOnClient`/`reverseEntryOnClient`** — the same posting and reversal logic as `createEntry`/`reverseEntry`, minus the `BEGIN`/`COMMIT`/`ROLLBACK`, taking the caller's own transaction client. This is what lets `invoiceService.issueInvoice`/`voidInvoice` post a real journal entry inside the *invoice's* transaction rather than a separate one — a document and its GL posting commit together or not at all (rule 5). `invoiceService` never writes `journal_entries`/`ledger_lines` directly.

**`utils/money.ts` gained `scaleCents`** — money × a rational factor (basis points, thousandths), exact `BigInt` arithmetic, half-up rounding — the only new money-arithmetic path this phase introduces. Line tax is computed per line and summed into the header, never computed once on a pre-summed subtotal, so a mixed-tax-rate invoice stays correct.

**`/api/v1/ledger-core/customers`** (4 routes), **`/api/v1/ledger-core/invoices`** (7 routes, including `POST /:id/issue` and `POST /:id/void`), **`/api/v1/ledger-core/settings/invoicing`** (2 routes). Full detail: [api.md](api.md). An invoice is a sales document, always in the organization's base currency (a different currency needs the Phase 8 FX engine); issuing allocates a number via a locked counter row (see [study/postgresql/gapless-numbering-and-counters.md](../study/postgresql/gapless-numbering-and-counters.md)) and posts one balanced entry — debit the receivable account, credit each distinct revenue account for its net, credit the tax account for the tax total if any. `PATCH`/`DELETE` on an invoice are legal only on a `DRAFT` (nothing posted yet); an `ISSUED` invoice's only correction is `POST /:id/void`, mirroring `POST /journals/:id/reverse`.

**Client:** a `Create` menu (`+`) in the LedgerCore rail, jumping to a new invoice/journal entry/customer/account. `InvoicesPage` (register), `NewInvoicePage` (draft create/edit, one page for both), `InvoiceDetailPage` (a printable document — `@media print` hides chrome — honoring the invoice settings' disclosure and branding choices), `CustomersPage`, `InvoiceSettingsPage`, and a two-tab `SettingsTabs` strip shared between `SettingsPage` (organization) and `InvoiceSettingsPage` (invoicing).

**Tests:** **340 server tests** (up from 280) across `organizations.test.ts`, `invoiceSettings.test.ts`, `customers.test.ts`, `invoices.test.ts`, and `invoiceConstraints.test.ts` (the raw-SQL, bypass-the-service suite proving the immutability triggers hold independently, mirroring `ledgerConstraints.test.ts`) — each module carrying its own cross-tenant isolation cases. **94 client tests** (up from 84).

**Deliberately not built:** a `PAID` status or any cash-receipt/payment document — an issued invoice's receivable never clears except by voiding, and the UI says so explicitly. No AR aging, no AR subledger report, no PDF export, no multi-currency invoices, no fiscal-period posting lock, no audit trail (that was Phase 5, delivered since — see [Phase 5, as delivered](#phase-5-as-delivered)). None of these are silently implied by anything shipped in this phase.

---

## Phase 3.9, as delivered

A fifth half-step, following the 3.5/3.6/3.7/3.8 lineage. **Renumbers nothing.** This phase closes the gap Phase 3.8 opened deliberately: accounts payable (vendors, bills, approval), and the settlement mechanism — payments — that both invoices and bills needed. It also pays off the "AR/AP subledgers" line item the roadmap table assigned to Phase 4; **Phase 4's remaining scope is P&L, balance sheet, and fiscal periods with close/lock, nothing else.**

**Migrations `011`–`014`:** `011` adds `vendors` (the AP mirror of `customers`, plus a `payment_terms` field). `012` adds three nullable AP posting-account columns to `ledger_settings` (`payable_account_id`, `tax_input_account_id`, `default_expense_account_id`), each a composite FK to `accounts`, no backfill needed. `013` adds `bills`/`bill_lines` plus two immutability triggers — the AP mirror of `009`, with one structural difference: bills have **four** lifecycle states (`DRAFT`/`AWAITING_APPROVAL`/`POSTED`/`VOID`), not three, because entering a bill and approving it for posting are deliberately separate acts of trust (`ACCOUNTANT` can enter and submit; only `OWNER`/`ADMIN` can approve). `014` adds `payments`/`payment_allocations` plus a **pair** of deferred constraint triggers — one mirroring `journal_entries`' parent-completeness check (a payment's allocations must exist and sum to its amount), one enforcing a genuinely new kind of invariant: allocations against one document, summed across every payment ever made against it — not just the current transaction's — must never exceed that document's total. Full detail: [schema.md § Phase 3.9](schema.md#phase-39--accounts-payable--payments-ledgercore--applied).

**Settlement is derived, never stored.** Neither `invoices` nor `bills` gained a `PAID` status or a stored paid-amount column — `allocatedCents`/`amountDueCents`/`settlementStatus` are computed on every read from `payment_allocations`, filtered to `POSTED` payments, the same no-summary-table discipline the trial balance and dashboard already follow. Voiding a payment un-settles its documents with **zero** additional writes: the allocation rows are immutable and simply stop counting once their payment leaves `POSTED`. See [study/architecture/derived-vs-stored-state.md](../study/architecture/derived-vs-stored-state.md).

**`journalService.createEntryOnClient`/`reverseEntryOnClient`** (from Phase 3.8) are reused, unchanged, by `billService.approveBill`/`voidBill` and `paymentService.createPayment`/`voidPayment` — a bill's approval posting, a payment's posting, and a void's reversal all commit inside the document's own transaction. Neither `billService` nor `paymentService` writes `journal_entries`/`ledger_lines` directly.

**`/api/v1/ledger-core/vendors`** (4 routes), **`/api/v1/ledger-core/bills`** (8 routes, including `POST /:id/submit`, `POST /:id/approve` — `OWNER`/`ADMIN` only — and `POST /:id/void`), **`/api/v1/ledger-core/payments`** (4 routes — no `PATCH`, a payment is born posted), **`GET /api/v1/ledger-core/reports/ar-aging`** / **`ap-aging`** (5 aging buckets, per-counterparty rows, and a `reconciles` check — the subledger total against the receivable/payable control account's GL balance, integer equality). Full detail: [api.md](api.md). `GET /reports/dashboard` gained `receivables`/`payables` blocks: outstanding/overdue totals, draft counts, and (for payables) the `awaitingReviewCount`/`awaitingReviewCents` bill-approval queue.

**Client:** `VendorsPage`, `BillsPage` (a seven-tab register — All/Draft/To review/Awaiting payment/Overdue/Paid/Void, mapped directly onto server-side `status`/`settlement` query params), `NewBillPage` (serves new/edit/duplicate via `?copyFrom=`), `BillDetailPage` (Submit/Approve/Record payment/Void, Approve gated to `OWNER`/`ADMIN` client-side too), `PaymentDialog` (shared by `InvoiceDetailPage` and `BillDetailPage`, defaults the amount to what's still due and caps it client-side), `PaymentsPage`. `InvoicesPage`/`InvoiceDetailPage` gained the same settlement figures, tab strip, and a `PaymentDialog` invocation. `DashboardPage` gained two panels ("Invoices owed to you", "Bills you need to pay") with a hand-rolled `BarChart` (five bars, aging buckets) — a second, separate component from `TrendChart`, not a generalization of it.

**Tests:** **442 server tests** (up from 340) — `vendors.test.ts`, `bills.test.ts`, `billConstraints.test.ts` (the raw-SQL trigger proof, including the `AWAITING_APPROVAL`-editable case), `payments.test.ts`, `paymentConstraints.test.ts` (proving both deferred triggers fire at `COMMIT`, not `INSERT`), `aging.test.ts` (boundary-exact bucket assignment plus `reconciles === true` for both AR and AP) — each carrying its own cross-tenant isolation cases. **107 client tests** (up from 94).

**Deliberately not built:** an expense-claim / employee-reimbursement document — there is no such thing in AutoLedger, by design; the bill-approval queue ("To review" / "Bills to review") is *not* that, it is unapproved vendor bills. No credit notes, no vendor credits, no partial void — a wrongly-priced posted document can only be voided in full and re-entered. No PDF export, no multi-currency invoices or bills (needs the Phase 8 FX engine), no fiscal-period posting lock, no audit trail (Phase 5, delivered since — see [Phase 5, as delivered](#phase-5-as-delivered)). Overdue/aging comparisons use UTC calendar dates, ignoring `ledger_settings.timezone`, matching every other date-bounded report in this codebase — an organization far from UTC can see a document flip to overdue up to a day early or late.

---

## Phase 4, as delivered

The last piece of "LedgerCore GL completion" as the phase table originally scoped it — 3.9 paid off the AR/AP subledger line item early, so this phase is narrower than its original box: fiscal periods with close/lock, a database-enforced posting guard, and the two remaining live statements, P&L and the balance sheet.

**Migrations `015`–`016`:** `015` adds `fiscal_periods` and the project's first `CREATE EXTENSION` (`btree_gist`) — required to mix a plain-equality tenant column into a GIST exclusion constraint alongside a `daterange` overlap operator. `ex_fiscal_periods_no_overlap` (`EXCLUDE USING GIST (org_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)`) makes two overlapping periods in one organization physically impossible to insert, race-free — closing the exact "check, then write" race a service-level pre-check alone would have. `016` adds `assert_period_open()`, a plain `BEFORE INSERT` trigger (not deferred) on both `journal_entries` and `ledger_lines`, rejecting any posting dated inside a `CLOSED` or `LOCKED` period. See [study/postgresql/exclusion-constraints-and-gist.md](../study/postgresql/exclusion-constraints-and-gist.md).

**The close/lock lifecycle is a three-value FSM** (`FISCAL_PERIOD_TRANSITIONS`): `OPEN -> CLOSED`, `CLOSED -> OPEN | LOCKED`, `LOCKED -> ` nothing. `LOCKED` is the first genuinely terminal state anywhere in the codebase's FSMs — `VOID` on invoices/bills is also a dead end, but for the opposite reason (the correction already happened); `LOCKED` is a dead end because the entire point of locking is the promise that nothing will ever happen to the period again. Locking must pass through `CLOSED` first — there is no `OPEN -> LOCKED` edge — so the FSM itself enforces that a period was reviewed before it becomes permanent. See [study/architecture/document-lifecycle-fsm.md § A genuinely terminal state](../study/architecture/document-lifecycle-fsm.md).

**The posting guard is checked twice, like the balance invariant.** `journalService.createEntryOnClient` (the single write path every document — manual journals, invoice issuance, bill approval, payments — posts through) calls `fiscalPeriodService.assertPeriodOpenOnClient` before writing; `reverseEntryOnClient` writes `journal_entries`/`ledger_lines` directly rather than delegating to `createEntryOnClient`, so it carries its own call to the same guard. Migration 016's trigger is the independent, second layer — the service being correct is not the reason a closed month stays closed. A date covered by no period at all is treated as open: an organization that has never generated periods keeps posting without any change in behavior.

**`reportService.profitAndLoss`/`balanceSheet`**, both aggregated from raw `ledger_lines` on every request — no summary table, the same discipline the trial balance and dashboard already follow. The P&L splits Revenue and Expense by type-aware sign (never a raw `debit − credit`, which would show revenue as negative) and by code prefix for COGS (the `5xxx` range — not a sixth account type, rule 12 stays exactly five). The balance sheet's `equity.retainedEarningsCents`/`currentEarningsCents` are **derived**, computed as `SUM(revenue) − SUM(expense)` split at the fiscal year boundary, never read from a posted account `3200` — LedgerCore posts no year-end closing entry, so there is nothing else they could be derived from. See [study/postgresql/aggregating-a-ledger.md § Deriving a P&L and a balance sheet from raw lines](../study/postgresql/aggregating-a-ledger.md).

**`/api/v1/ledger-core/fiscal-periods`** (6 routes: list, get, generate, close, reopen, lock — `lock` is `OWNER`-only, the rest `OWNER`/`ADMIN`, reading open to any member) and **`GET /reports/profit-and-loss`** / **`GET /reports/balance-sheet`** (2 routes, any member). Full detail: [api.md](api.md). Client: `FiscalPeriodsPage` (a register with per-status actions and a `ConfirmDialog` gating only `Lock`, the one irreversible action — `Close`/`Reopen` act immediately, both being reversible), `ProfitAndLossPage`, `BalanceSheetPage` (both linking postable account names into their ledgers, mirroring the trial balance); `ReportsPage`'s two disabled "Phase 4" placeholder cards are now real links.

**Tests: 490 server tests** (up from 442) — `fiscalPeriods.test.ts`, `fiscalPeriodConstraints.test.ts` (the raw-SQL proof that the exclusion constraint and CHECKs hold independently of the service), `periodLock.test.ts` (the posting guard, exercised through manual journals, reversals, and invoice issuance alike, plus the trigger-path proof bypassing the service), `statements.test.ts` (a non-trivial fixture proving `Assets = Liabilities + Equity` by integer equality, an `information_schema` assertion that no summary table exists anywhere, and a cross-check that the P&L's net income for a fiscal year equals the balance sheet's current-period earnings at that year's end) — each carrying its own cross-tenant isolation case. **120 client tests** (up from 107).

**Deliberately not built:** no year-end closing journal entry — retained earnings stays derived indefinitely unless one is added later, and an organization that manually posts its own closing entry into `3200` will see that year's earnings counted twice, a stated and accepted gap rather than a guarded one. Quarterly or 4-4-5 fiscal calendars — `fiscal_periods.period_number` is capped at 12 monthly periods by CHECK. No per-period P&L drilldown, no PDF export, no audit trail (Phase 5, delivered since — see [Phase 5, as delivered](#phase-5-as-delivered), immediately below). Period boundaries and every date comparison here use UTC calendar dates, ignoring `ledger_settings.timezone`, matching aging and every other date-bounded report in this codebase.

---

## Phase 5, as delivered

Shared infrastructure, not a LedgerCore-only phase — the trail spans every app via `app_slug`, and closes the compliance gap every prior phase entry has flagged: **"no audit trail yet, no compliance claim should be made before it lands."** It has landed.

**Migrations `017`–`018`, platform-level (no app-slug tag).** `017` creates `audit_logs` — a `BIGINT GENERATED ALWAYS AS IDENTITY` primary key rather than this schema's usual UUID (a log's defining property is arrival order, which a UUID carries none of), `txid` (`pg_current_xact_id()`) grouping every row one transaction wrote, `org_id`/`app_slug`/`table_name`/`row_id`/`operation`/`old_row`/`new_row`/`changed_keys`/`actor_user_id`/`client_ip`/`created_at` — plus `audit_row_change()` (the generic `to_jsonb(NEW)`/`to_jsonb(OLD)` capture trigger, one function shared by every audited table) and `reject_audit_log_mutation()` (the same `0A000` immutability treatment `journal_entries` already has). `018` attaches `audit_row_change()` as an `AFTER INSERT OR UPDATE OR DELETE` trigger to 16 tables — every LedgerCore financial table plus `organizations`/`organization_members`. Deliberately not audited: `users`/`refresh_tokens` (a password hash or session credential has no business inside a JSONB snapshot) and `schema_migrations`.

**`org_id`, `row_id`, and `actor_user_id` carry no `REFERENCES`** — the one deliberate, documented exception to guardrails rule 8 anywhere in this schema. An audit row has to outlive the organization, row, and user it describes; a cascading or restricting FK would either destroy the very history it should preserve, or make deletion of an audited row's parent permanently impossible. See [study/architecture/append-only-audit-trails.md](../study/architecture/append-only-audit-trails.md).

**The actor and client IP reach a trigger that cannot see `req` via `AsyncLocalStorage` and a transaction-local session variable.** `middleware/requestContext.ts`'s `attachRequestContext` opens a per-request context — mounted first in `app.ts`, before `cors` — and `middleware/auth.ts`'s `authenticate` fills in `userId`/`orgId` on it once the access token verifies. `db/transaction.ts`'s new `beginTransaction`/`withTransaction` publish that context into PostgreSQL immediately after every `BEGIN`, via `set_config('app.current_user_id', ..., is_local := true)` — the *function* form, not `SET LOCAL`, because only the function form accepts its value as a genuine bind parameter (guardrails rule 4). `is_local := true` is what makes this safe on a connection pool: the setting is discarded at `COMMIT`/`ROLLBACK`, so it can never leak from one pooled request into the next. See [study/node-express/async-local-storage-request-context.md](../study/node-express/async-local-storage-request-context.md) and [study/postgresql/audit-triggers-and-session-variables.md](../study/postgresql/audit-triggers-and-session-variables.md).

**Every write transaction in the codebase was touched to make this possible, not just LedgerCore's.** The 20 pre-existing `client.query('BEGIN')` call sites, across `authService`, `organizationService`, and ten `ledger-core` services, became `beginTransaction(client)`. The 10 single-statement writes that previously ran directly on `pool` (`accountService`/`customerService`/`vendorService`'s `create`/`update`, `invoiceSettingsService.updateInvoiceSettings`, `settingsService.updateSettings`, `invoiceService.deleteInvoice`, `billService.deleteBill`, `organizationService.updateOrganization`'s default path) now run inside `withTransaction(...)` — every write, not only the ones that already happened to transact, now has a transaction for the audit context to attach to.

**`/api/v1/audit-logs`** (2 routes: list, get-one — both `OWNER`/`ADMIN` only, deliberately narrower than `/reports`/`/fiscal-periods`, since the trail records what an `ACCOUNTANT` did and the bookkeeper doesn't hold the key to their own log). Mounted platform-level, not under `/ledger-core` — `app_slug` on each row carries the app namespace instead (guardrails rule 16). The list omits `oldRow`/`newRow`; the detail route returns both, plus `changedKeys` for an UPDATE. A non-numeric or cross-tenant `id` returns `404`, never `400`/`403`. Full detail: [api.md](api.md). Client: `AuditLogPage` — filterable by app/table/operation, click-to-expand before/after diff, reached from LedgerCore's rail (the natural home until a second app ships a UI, since the trail itself is platform-wide).

**`npm run verify:integrity`** — `db/integrity.ts` (pure, importable) + `scripts/verifyIntegrity.ts` (the CLI tail, split out specifically so importing the checker from a test never exits the test process). Three checks, each unscoped by `org_id` on purpose — the single other sanctioned exception to rule 1 in the codebase, isolated in `src/db/` so nothing request-serving can import it by accident: total debits equal total credits across the whole database; every journal entry balances on its own (`GROUP BY` + `HAVING`, not `WHERE`); no `ledger_lines` row is orphaned or claims the wrong `org_id` (a `LEFT JOIN`/`IS NULL` anti-join, not `NOT IN`, which has a NULL-handling trap). `server/src/__tests__/integrity.test.ts` proves the checker **can fail** — the roadmap's own stated requirement — by disabling every user trigger on `journal_entries`/`ledger_lines` (`ALTER TABLE ... DISABLE TRIGGER USER`), inserting the exact broken rows the schema normally prevents, and re-enabling in a `finally`. See [study/postgresql/integrity-checking-a-ledger.md](../study/postgresql/integrity-checking-a-ledger.md).

**Tests: 519 server tests** (up from 490) — `integrity.test.ts` (4 cases, including the two that manufacture broken data), `platform/auditTrail.test.ts` (10 — capture correctness, org scoping, the `users`/`refresh_tokens` exclusion, the immutability guard, cross-tenant isolation), `platform/auditActor.test.ts` (6 — actor/IP attribution end-to-end through HTTP, a multi-table transaction sharing one `txid`, a null actor for a request-less write, and the pooled-connection non-leak case), `platform/auditLogs.test.ts` (9 — filtering, role gating, cross-tenant isolation on both the list and the detail route). **125 client tests** (up from 120) — `ledgerCoreAuditLog.test.tsx`.

**Deliberately not built:** retention or partitioning on `audit_logs` — a stated, accepted cost, not an oversight: registering an organization now writes roughly 46 audit rows via the default-chart seed, and a 20-line journal entry writes 21. No hash-chaining or other tamper-evidence beyond the immutability trigger — a table-owner-privileged actor can still `ALTER TABLE ... DISABLE TRIGGER` first, exactly as the checker's own test does; this trail is a strong guarantee against application-level tampering, not an absolute one, and no compliance claim should overstate that. No scheduled/continuous integrity check — `verify:integrity` runs on demand until Phase 7's background jobs exist. **Every prior phase's "no audit trail (Phase 5)" caveat elsewhere in this document, in `ledger-core.md`, and in `CLAUDE.md` has been corrected with a pointer to this section** — the historical claim ("this phase didn't build it") stays accurate; only the implication that it's still true today has been removed.

---

## Phase renumbering — 2026-09-01

LedgerCore and AP-Flow were specified in full before Phase 3 started, and both turned out to be roughly three times the scope the table allotted them. Bank reconciliation, the confidence-matching engine, the integrity checker, DB-level balance triggers, sub-account hierarchies, financial webhooks, document storage, and PII redaction as shared infrastructure appeared nowhere in the previous table. Rather than let two phases silently swell, LedgerCore was given a contiguous block (3–9, with shared infrastructure landing where LedgerCore first needs it) and AP-Flow was split in two (10–11). Everything downstream shifted.

Phase numbers are cited in [development.md](development.md)'s dependency policy and in [study/README.md](../study/README.md)'s coverage tracker, so the mapping is recorded rather than left to be inferred:

| Was | Is now | Note |
|---|---|---|
| 4 — LedgerCore GL completion | 4 | Narrowed to live statements + fiscal periods; AR/AP subledgers stay |
| 6 — background jobs | 7 | Also absorbs financial-event webhooks, which need a queue by rule 5 |
| 7 — FX + QuickBooks | 8 and 9 | Split; two unrelated bodies of work sharing one number |
| 8 — AP-Flow | 10 and 11 | Split at the posting boundary: extraction produces a draft, mapping posts it |
| 9 — FP&A Engine | 12 | |
| 10 — ForecasterPro | 13 | |
| 11 — UnitEcon | 14 | |
| 12 — BoardDeck Automator | 15 | |
| 13 — TaxGuard AI | 16 | |

Phase 5 (CDC audit trail) keeps its number. Phases 0–3 are unaffected.

**Two settled rulings are amended by this entry.** Both were written down as decided, so both are reversed in the open rather than quietly:

1. **The LLM carve-out widens to a second app.** The [Phase 2](#phase-2-as-delivered) entry reversed the blanket "no LLM dependency" ban *for TaxGuard AI specifically*. AP-Flow's multimodal document extraction (Phase 10) needs a vision model, so the carve-out now covers two apps and `@anthropic-ai/sdk` becomes a Phase 10 dependency. Rule 14 in [CLAUDE.md](../CLAUDE.md) and [guardrails.md](guardrails.md) is corrected to match. The rule itself is unchanged: no dependency before the phase that needs it, and no LLM SDK outside the phases named here.
2. **PII redaction is no longer TaxGuard-owned.** It is listed in the app table as a TaxGuard AI skill. Two apps now consume it, so it becomes shared infrastructure — `services/redactionService.ts` at the services-layer root, unprefixed, the same status as `authService`. This does not violate rule 16: it reads no app's tables, and it is a pure text/image transform.

---

## Phase 6, as delivered

Closes LedgerCore's last GL-completion gap — reconciling the ledger against a real bank statement, with confidence-scored matching so most lines never need a human decision.

**Migration `019`, LedgerCore-tagged.** Three tables: `bank_statement_imports` (one row per uploaded CSV — file name, delimiter, date format, row/imported/duplicate counts, and an optional stated closing balance), `bank_transactions` (one row per parsed line, `amount_cents` **signed** — positive is money in, negative out, unlike a `ledger_lines` row which always has exactly one side populated — and a `UNIQUE (org_id, dedupe_hash)` constraint that makes re-importing a statement idempotent), and `bank_match_suggestions` (up to 5 scored candidates per unmatched line, deleted and regenerated wholesale on every rescore, deliberately **not** audited since it's disposable derived data). `bank_transactions` gets the same `to_jsonb` row-diff immutability carve-out `payments` (014) has — only its match state may change, `DELETE` always rejected — because a bank line is a record of fact from a downloaded statement. See [study/postgresql/idempotent-ingestion-and-dedupe-hashes.md](../study/postgresql/idempotent-ingestion-and-dedupe-hashes.md).

**Nothing new was installed.** The CSV parser (`utils/csv.ts`, a hand-written two-pass state machine — quoted commas, embedded newlines, doubled-quote escaping, BOM stripping, delimiter sniffing outside quotes), the flexible date parser (`utils/dateParse.ts`, `ISO`/`DMY`/`MDY` plus month-name forms), the untrusted-text money parser (`utils/money.ts`'s new `parseMoneyText`, asymmetric dot/comma separator resolution, accounting parentheses and `CR`/`DR` notation, no intermediate float), and the Levenshtein distance implementation (`utils/levenshtein.ts`, a rolling-array `O(min(m,n))`-space DP) are all hand-written, exactly as this phase's roadmap entry always specified. A CSV statement arrives as a JSON string field, not a multipart upload — file storage stays Phase 10's problem — capped by `MAX_CSV_CHARS` (900,000 characters) comfortably under the 1MB JSON body limit.

**The 40/30/30 confidence engine** (`utils/matchScore.ts`) scores each unmatched line against open invoices (positive amounts) or bills (negative amounts) dated within ±30 days: 40 points for an exact integer-cent amount match, up to 30 for date proximity (stepped down by whole days apart, not continuous decay), up to 30 for counterparty text similarity (the document's number or the counterparty's name found in — or Levenshtein-similar to — the bank memo). A hand-tuned noise floor (0.5 similarity) keeps coincidental letter overlap between unrelated strings from reading as real evidence; `AUTO_MATCH_THRESHOLD` (85) is set high on purpose, since a false auto-match posts a real payment against the wrong document while a missed suggestion just costs one extra click. Every score is stored with its full breakdown (`{ amount, date, counterparty }`, each with `points`/`maxPoints`/a human-readable `reason`), so a suggestion is explainable on screen, never a bare number. See [study/architecture/fuzzy-matching-and-confidence-scoring.md](../study/architecture/fuzzy-matching-and-confidence-scoring.md).

**Matching posts through the existing payment path, never a direct GL write.** `paymentService.createPayment`/`voidPayment` were split into `createPaymentOnClient`/`voidPaymentOnClient` (the transaction-taking half) plus a thin wrapper that owns the connection — mirroring the split `journalService.createEntryOnClient` already had — so `bankMatchService.matchTransaction` can post a payment and update the bank line's status inside one transaction, and `unmatchTransaction` can void that payment and revert the line inside another. `BANK_TRANSACTION_TRANSITIONS` (`UNMATCHED -> MATCHED | IGNORED`, `MATCHED -> UNMATCHED`, `IGNORED -> UNMATCHED`) is the first FSM in this codebase where a non-terminal reverse edge carries a GL side effect rather than touching only its own row — and since `/unmatch` and `/unignore` both legally land on `UNMATCHED` by the shared table alone, `unmatchTransaction` layers its own narrower `status === 'MATCHED'` check on top of the FSM check rather than in place of it. A bank line settles **at most one document**, in full or in part — never a batch of several. See [study/architecture/document-lifecycle-fsm.md § A reversible state whose reverse edge carries a GL side effect](../study/architecture/document-lifecycle-fsm.md).

**`/api/v1/ledger-core/bank-imports`** (3 routes: list, get-one, import) and **`/api/v1/ledger-core/bank-transactions`** (7 routes: list, get-one, rescore, match, unmatch, ignore, unignore) — every mutation gated `OWNER`/`ADMIN`/`ACCOUNTANT`, the same set `/payments` uses, since matching and unmatching each post or void a real journal entry. **`GET /reports/bank-reconciliation`** compares a bank account's posted GL balance against its imported statement lines, both computed independently and compared by integer equality — but unlike `/ar-aging`/`/ap-aging`'s `reconciles`, a `false` result here is a **completeness** claim about the imported statement history, not a **correctness** claim about the books: the two sides describe different realities (this system's own postings vs. a CSV a human chose to upload), so the far more common cause of disagreement is a missing import, not a bug. See [study/postgresql/subledger-reconciliation-and-aging.md § Bank reconciliation](../study/postgresql/subledger-reconciliation-and-aging.md). Full detail: [api.md](api.md). Client: `BankImportPage` (the CSV's text goes straight into the JSON body, read via `FileReader`, never a multipart upload), `BankTransactionsPage` (the approval queue — status tabs, inline suggestion cards with `MatchScoreBadge` and the three-reason breakdown, one-click Accept at or above the threshold, `ConfirmDialog`-gated Match below it and Unmatch always), `BankReconciliationPage`; a new "Banking" sidebar group.

**Tests: 645 server tests** (up from 519) — `csv.test.ts` (14), `dateParse.test.ts` (19), `levenshtein.test.ts` (13), `matchScore.test.ts` (10), 17 new cases in `money.test.ts` for `parseMoneyText`, `bankConstraints.test.ts` (13, raw-SQL proof of the dedupe/immutability/FK constraints, including the cross-tenant dedupe-scoping case), `bankImports.test.ts` (12, including the roadmap's own acceptance criterion as a named test — `'the same statement imported twice yields one set of rows'` — and two cross-tenant cases), `bankMatching.test.ts` (18, including a deterministic 100-line fixture proving **zero false auto-reconciles above the threshold** — the roadmap's other acceptance criterion — plus the closed-period interaction and two cross-tenant cases), `bankReconciliation.test.ts` (8, including a cross-tenant case). **139 client tests** (up from 125) — `ledgerCoreBankImport.test.tsx`, `ledgerCoreBankTransactions.test.tsx`, `ledgerCoreBankReconciliation.test.tsx`. `npm run verify:integrity` passes after the full suite runs, confirming the matching engine posted only balanced entries throughout.

**Deliberately not built:** a bank line settling more than one document, or several lines settling one, in a single match. Bank feeds, Open Banking, OFX/QIF/MT940 — CSV only. Multi-currency statements. Posting a journal entry directly from an unmatched line for bank fees or interest — `IGNORE` covers that case for now. No new dependency of any kind — the CSV parser, date parser, money-text parser, and Levenshtein distance are all hand-written, exactly as this phase's roadmap entry specified from the start.

---

## Phase 7, as delivered

Shared infrastructure, not owned by any one app: a real background-job system on Redis, and the first consumer of it — outbound financial-event webhooks, built on a transactional outbox so a notification can never be lost to a crash between commit and send.

**Two new dependencies, exactly as scheduled since Phase 0.** `bullmq` (^6.3.4) and `ioredis` (^6.0.0) — nothing else. `REDIS_HOST`/`REDIS_PORT`/`REDIS_DB` join `server/.env`, all optional with defaults matching `docker-compose.yml`; the Redis container (provisioned since Phase 0, unused until now) gains a healthcheck. `npm run worker` (`tsx watch src/worker.ts` in dev, `worker:start` against the built output) starts a second process — its own event loop, its own `pg` pool, its own crash domain — consuming three queues (`integrity-check`, `outbox-drain`, `webhook-deliver`) plus a fourth, `dead-letter`, that nothing consumes by design: it exists to accumulate visibly rather than requiring an operator to know to look inside a queue's own failed set. Retry policy is 5 attempts with exponential backoff from 1s outside tests; a job that exhausts its retries is enqueued to `dead-letter` by the worker's own `'failed'` listener, not by BullMQ itself. See [study/architecture/background-jobs-and-queues.md](../study/architecture/background-jobs-and-queues.md).

**The transactional outbox closes the gap guardrails rule 5 has named since Phase 0** — no post-`COMMIT` follow-up work in the same function, which an HTTP call to a webhook receiver structurally cannot honor if made inside the transaction (it would hold a database connection open across a network round trip) or after it (a crash in the gap loses the notification with no durable record it was ever supposed to happen). Migration `020`, platform-tagged: `outbox_events` (written on the *caller's own transaction client* — `outboxService.emitEvent(client, ...)`, never `pool` — so the event commits or rolls back atomically with the financial fact it describes), `webhook_endpoints` (a tenant's registered receivers, `secret` stored in plaintext because the server must reproduce the exact HMAC key on every send — never selected into any API response), and `webhook_deliveries` (one row per event per subscribed endpoint, tracking every attempt). A repeatable job drains the outbox every 5 seconds: `FOR UPDATE SKIP LOCKED` claims a batch of unpublished events (the same primitive, at larger scale, `refresh_tokens` rotation uses at the single-row scale — see [study/postgresql/transactions-isolation-pooling.md](../study/postgresql/transactions-isolation-pooling.md)), fans each out to its org's active subscribed endpoints as `PENDING` deliveries (`UNIQUE (event_id, endpoint_id)` + `ON CONFLICT DO NOTHING` makes the fan-out itself idempotent), and a second pass in the same drain re-enqueues any `PENDING` delivery whose Redis job looks lost — the compensation for the unavoidable gap between committing the delivery row and successfully calling `queue.add()`. This is honest **at-least-once** delivery, not exactly-once: a receiver is expected to dedupe on `deliveryId`. Full mechanism: [study/architecture/transactional-outbox.md](../study/architecture/transactional-outbox.md).

**Five events, chosen to be testable end to end rather than exhaustive:** `invoice.issued`, `bill.approved`, `payment.recorded` (emitted from `paymentService.createPaymentOnClient` specifically — not the thin `createPayment` wrapper — so a payment born from a bank match, Phase 6's `bankMatchService.matchTransaction`, fires the identical event a manually-posted payment does), `fiscal_period.closed` (on `CLOSED` only, never on `LOCKED` or on reopen), and `bank.large_unmatched` (a new `ledger_settings.unmatched_alert_threshold_cents` column, migration `021`, `DEFAULT 0` meaning disabled for every organization including ones that predate the migration; a signed bank-line `amount_cents` compared by `Math.abs` against the threshold, so a large outflow alerts exactly as a large inflow does). There is deliberately no `payment.voided` event and no endpoint-level custom-event support — inventing either was judged a later phase's call, not this one's.

**HMAC-SHA256 signing, and a write-time SSRF guard on every endpoint URL.** Every delivery carries `X-AutoLedger-Signature: sha256=<hex>`, computed over `${timestamp}.${rawBody}` — folding the timestamp into the signed material gives replay protection for free, since a captured request can't be replayed with a fresh timestamp without knowing the secret. `assertDeliverableUrl` rejects `localhost`/`*.internal`, every private/reserved IPv4 range including the cloud metadata address `169.254.169.254`, embedded credentials, and non-`https` outside development; `redirect: 'manual'` on every outbound `fetch` stops a receiver's own redirect from silently reaching a private address the guard would have rejected as the original URL. DNS rebinding — a hostname re-pointed to a private IP *after* the write-time check — is a recorded, accepted gap: closing it needs a resolve-then-connect-to-the-resolved-IP flow Node's built-in `fetch` doesn't expose a hook for. See [study/security-auth/webhook-signing-and-ssrf.md](../study/security-auth/webhook-signing-and-ssrf.md).

**`/api/v1/webhooks`** (6 routes: list, create, get-one, update, `OWNER`-only delete, `OWNER`-only rotate-secret) and **`/api/v1/webhook-deliveries`** (3 routes: list, get-one, retry) — both platform-level, not namespaced under `/ledger-core`, mirroring `/audit-logs` (guardrails rule 16: an app-owned event still lands in shared, platform-owned machinery). The secret is present in exactly two responses, `create` and `rotate-secret`, and never elsewhere — a page reload loses it by design, which the client's `WebhooksPage` states in a dismissible one-time panel. `POST /:id/retry` is legal only from `FAILED` (`409` from `PENDING` or `DELIVERED`) and returns `202`, since the send is accepted for processing, not performed synchronously. Full detail: [api.md](api.md). Client: `WebhooksPage` (endpoint CRUD, the secret-reveal panel, `ConfirmDialog`-gated rotate and delete), `WebhookDeliveriesPage` (server-side-filtered delivery log, expand-to-payload, Retry gated to `FAILED` rows), a new "Automation" sidebar group.

**Phase 5's own recorded debt is paid here too:** `verify:integrity`'s three whole-database checks now also run automatically once a day via the worker's job scheduler, not only on demand — see [Phase 5, as delivered](#phase-5-as-delivered) above.

**Tests: 717 server tests** (up from 645) — `platform/queue.test.ts` (job processing, retry-then-dead-letter, jobId dedup), `platform/webhookEndpoints.test.ts` (31, including the URL-guard and signature unit cases and the mandatory cross-tenant suite), `platform/outboxDrain.test.ts` (8, including the transaction-rollback-leaves-no-row proof and a cross-org fan-out isolation case), `platform/webhookDelivery.test.ts` (17, `fetch` stubbed at the boundary per [testing.md](testing.md), including the signature-verification and no-secret-in-body assertions, plus one case against the real worker wiring proving exhausted retries mark a delivery `FAILED` and dead-letter the job), `ledger-core/outboxEmission.test.ts` (11, one case per event type plus the rollback-emits-nothing proof for a locked-period invoice issue), plus updates to `health.test.ts` for the new `redis` block. **144 client tests** (up from 139) — `ledgerCoreWebhooks.test.tsx`, `ledgerCoreWebhookDeliveries.test.tsx`. The integration suite now requires `docker compose up -d redis` in addition to `postgres`; `globalSetup` flushes Redis database index 1 (never index 0) before the run, mirroring the existing `autodb_test`-not-`autodb` discipline.

**Deliberately not built:** Redis-backed per-account rate limiting — `constants.ts` has said "arrives with Redis in Phase 7" since Phase 3, and that specific claim is now corrected: it needs `rate-limit-redis`, which is not an approved Phase 7 dependency, so the login/register limiter stays per-IP. `POST /webhooks/:id/test` (a one-off send would bypass the outbox and be a second, untested delivery path). A `payment.voided` event, or any event type beyond the five named above. Per-endpoint retry-policy overrides. Retention or partitioning on `webhook_deliveries` — the same accepted, stated cost `audit_logs` carries since Phase 5. Full DNS-rebinding closure on the webhook URL guard (see above).

---

## App map

The domain, headline skills, and DB/engineering pattern for each app in the suite.

### LedgerCore — Core Accounting & Systems — Phases 3–4, 6, 8–9

The system of record every other app posts into. Double-entry integrity enforced by the database itself, an append-only ledger, multi-currency, bank reconciliation, and a QuickBooks API sync. Full spec: [ledger-core.md](ledger-core.md).

*Includes:* chart of accounts with parent/child hierarchy, manual journal entries, reversing entries, trial balance, fiscal periods with close/lock, P&L, balance sheet, AR/AP subledgers, bank CSV ingestion with confidence matching, multi-currency FX with realized and unrealized gain/loss, QuickBooks Online sync.

*Pattern:* strict double-entry validation inside `BEGIN...COMMIT`, all amounts integer cents, and the same invariant enforced a second time by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires at `COMMIT` — the application is not the only thing standing between the ledger and an unbalanced entry. Posted rows are immutable by trigger, not by convention. `source_type` / `source_id` on `journal_entries` is the hook every other app uses to post into the GL.

### TaxGuard AI — Compliance & AI Workflows — Phase 16

Tax-law question answering grounded in real statute text, not model recall.

*Pattern:* RAG over `pgvector`, tax act parsing into retrievable chunks with citations. Consumes the shared redaction service rather than owning it — see the [Phase renumbering](#phase-renumbering--2026-09-01) entry.

### AP-Flow — Operational Accounting — Phases 10–11

A photograph of a receipt becomes a balanced, auditable journal entry. Full spec: [ap-flow.md](ap-flow.md).

*Pattern:* documents are OCR'd **locally** first, so PII can be located and masked on the pixels before any image reaches an external vision model; the redacted image then goes to Claude Vision for structured extraction with per-field confidence. GL coding is inferred from the organization's own posting history before a model is consulted. Individual line items map to distinct accounts, not one lump total. Posts into LedgerCore via `source_type = 'ap_flow'`, stamping the source document's SHA-256 onto the entry so an auditor can walk from a ledger line back to the original image.

### FP&A Engine — Financial Modeling — Phase 12

A linked 3-statement model you can stress-test.

*Pattern:* 3-statement financial linking (income statement → balance sheet → cash flow, changes propagate), scenario modeling, cash runway forecasting.

### ForecasterPro — Budgeting & Planning — Phase 13

Driver-based forecasts instead of a spreadsheet copied forward.

*Pattern:* driver-based rolling forecasting, headcount planning, zero-based budgeting. Builds on FP&A Engine's linked model.

### UnitEcon — Commercial Analytics — Phase 14

Unit economics, not just revenue.

*Pattern:* cohort retention matrices, LTV/CAC ratios, Price-Volume-Mix variance decomposition.

### BoardDeck Automator — Board Reporting & Close — Phase 15

Close the books, generate the board deck.

*Pattern:* monthly close automation, budget-vs-actual (BvA) variance, automated `.pptx` deck generation. Depends on background jobs (Phase 7) and ForecasterPro's budgets (Phase 13).

---

## Cross-cutting infrastructure

**Audit trail & CDC (Phase 5) ✅ delivered — see [Phase 5, as delivered](#phase-5-as-delivered).** System-wide PostgreSQL triggers capturing `OLD` and `NEW` row states into a centralized, immutable `audit_logs` table as `JSONB`, alongside `org_id`, actor `user_id`, client IP, table name, operation, and timestamp — shared across every app. A trigger cannot see `req`, so the actor and IP reach it through `set_config('app.current_user_id'/'app.client_ip', ..., true)` set inside the same transaction and read back with `current_setting(..., true)`. This is distinct from `updated_at` timestamp triggers — write both, but do not confuse one for the other.

Phase 5 also shipped **`npm run verify:integrity`**: a standalone checker asserting that total debits equal total credits across the entire database, that every journal entry balances individually, and that no ledger line is orphaned. It is the script you run in front of an auditor, and it is proven able to fail (`server/src/__tests__/integrity.test.ts`).

**Background jobs (Phase 7) ✅ delivered — see [Phase 7, as delivered](#phase-7-as-delivered).** `bullmq` + `ioredis`, a worker process, retry/DLQ policy — shared infrastructure that AP-Flow, ForecasterPro, BoardDeck Automator, and TaxGuard AI all build on.

Phase 7 also delivered **financial-event webhooks** — an outbound notification when a watched condition fires, e.g. a large unmatched bank transaction reaching the ledger. Webhooks landed here and not earlier because rule 5 forbids post-`COMMIT` follow-up work: an HTTP call to a receiver cannot be made inside the posting transaction, and firing it after `COMMIT` without a queue means a crash between the two silently loses the notification — the transactional outbox this phase built is exactly the mechanism that closes that gap.

**Document storage (Phase 10).** AP-Flow retains every source document, hash-addressed on the local filesystem under `server/storage/`, with the SHA-256 recorded in the database. This is deliberately the simplest thing that satisfies the audit requirement, and it does **not** survive a multi-instance deployment; the storage service keeps a narrow interface (`put(buffer) → hash`, `get(hash) → stream`) so object storage is a one-file swap when deployment becomes real.

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
