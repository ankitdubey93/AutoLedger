# AutoLedger — CLAUDE.md

AutoLedger is a suite, not one app: a shared identity/tenancy platform hosting **three portfolio applications**, each demonstrating a different accounting or engineering skill.

| App | Slug | Domain | Core skills |
|---|---|---|---|
| LedgerCore | `ledger-core` | Core Accounting & Systems | Double-entry enforced by DB trigger, immutable ledger, multi-currency FX, bank reconciliation with confidence matching, QuickBooks API sync — [docs/ledger-core.md](docs/ledger-core.md) |
| AP-Flow | `ap-flow` | Operational Accounting | Multimodal OCR invoice parsing, PII pixel masking, history-driven COA mapping, human-in-the-loop review — [docs/ap-flow.md](docs/ap-flow.md) |
| StockLedger | `stock` | Inventory & Warehousing | Industry inventory templates, custom item attributes, configurable item codes, QR labels, perpetual moving-average/specific-identification valuation — [docs/stock.md](docs/stock.md) |

All three apps have real routes (`status: 'building'` in `server/src/config/apps.ts`).

## State: Phase 29 done — five apps retired, three remain

On 2026-07-30 the previous single-user bookkeeping build (`server/`, `client/`, ~65 files) was **deleted deliberately** for a from-scratch rebuild. There is no legacy code to preserve, extend, or migrate. Do not reference old files by path — they do not exist.

**Built, one line each — full detail lives in [docs/roadmap.md](docs/roadmap.md) under each phase's own "as delivered" heading (`#phase-N-as-delivered`); nothing below is the authoritative version:**

- **Phase 0** — scaffold: Express 5 + TS strict server, React 19 + Vite 8 client, Postgres + Redis in Docker.
- **Phase 1** — identity + tenancy: migration runner, `authService`, `/api/v1/auth` + `/api/v1/organizations`, RBAC, httpOnly refresh-rotated sessions.
- **Phase 2** — the app registry, client chooser, per-app shell. 95 server + 15 client tests.
- **Phase 3** — LedgerCore's GL core: chart of accounts, journal entries, trial balance, double-entry enforced by DB triggers, posted-row immutability.
- **Phase 3.5** — LedgerCore onboarding wizard, settings, dashboard (half-step, no renumbering).
- **Phase 3.6** — journal register filters, account ledger with running balance, balances via recursive CTE.
- **Phase 3.7** — ledger navigation (duplicate/reverse actions) and chart-of-accounts create form, client-only.
- **Phase 3.8** — sales invoicing (AR): customers, invoices, issue/void, `ConfirmDialog`/`BackLink` introduced.
- **Phase 3.9** — bills & payments (AP): vendor bills with approval FSM, payments with derived settlement, AR/AP aging.
- **Phase 4** — P&L, balance sheet, fiscal periods with close/lock FSM (`LOCKED` terminal), derived retained earnings.
- **Phase 5** — shared CDC audit trail (`audit_logs`, `AsyncLocalStorage`-carried actor/IP) and `npm run verify:integrity`.
- **Phase 6** — LedgerCore bank reconciliation: CSV ingestion, the 40/30/30 confidence-matching engine, approval queue.
- **Phase 7** — shared background jobs (`bullmq` + `ioredis`, worker process) and outbound financial-event webhooks.
- **Phase 8** — multi-currency FX engine: `fx_rates`, realized gain/loss on settlement, period-end unrealized revaluation.
- **Phase 9** — platform onboarding state (all apps) plus LedgerCore's staged chart/opening-balance importer.
- **Phase 9.5** — the Document Vault: platform-level hash-named file storage and cross-app attachment links.
- **Phase 10** — AP-Flow capture & extraction: local OCR, PII pixel masking before any image leaves the machine, Claude Vision.
- **Phase 11** — AP-Flow mapping, review & posting: history-first COA classification, tax split, one-click post into LedgerCore.
- **Phase 12** — FP&A Engine, **removed in Phase 29**. Never revived; see [docs/roadmap.md](docs/roadmap.md#phase-29-as-delivered).
- **Phase 13** — ForecasterPro, **removed in Phase 29**. Never revived; see [docs/roadmap.md](docs/roadmap.md#phase-29-as-delivered).
- **Phase 14** — UnitEcon, **removed in Phase 29**. Never revived; see [docs/roadmap.md](docs/roadmap.md#phase-29-as-delivered).
- **Phase 15** — BoardDeck Automator, **removed in Phase 29**. Never revived; see [docs/roadmap.md](docs/roadmap.md#phase-29-as-delivered).
- **Phase 16** — TaxGuard AI, **removed in Phase 29**. Never revived; see [docs/roadmap.md](docs/roadmap.md#phase-29-as-delivered).
- **Phase 18** — the sandbox dataset, **removed in Phase 29**. Never revived; see [docs/roadmap.md](docs/roadmap.md#phase-29-as-delivered). (Phase 17, QuickBooks, stays deferred and unbuilt.)
- **Phase 19** — AP-Flow automated intake: a second extraction/classification provider (Gemini, alongside Claude, `AP_FLOW_AI_PROVIDER`), posting rewritten onto a real LedgerCore bill (fixing a Phase 11 bug where AP aging never reconciled), a confidence-gated auto-post off by default per org, and direct upload from AP-Flow's own page. Google Drive folder intake, part of this phase's original scope, was deferred — delivered in Phase 19.2 below.
- **Phase 19.1** — AI token/cost metering: a platform-level `ai_model_calls` table (adoptable by any app, not just AP-Flow) records every model call's tokens, latency and cost when the model carries a verified price (`config/aiPricing.ts`); a model with no price records real tokens and an honest `NULL` cost rather than a fabricated number. `GET /api/v1/ai-usage` plus a per-document panel and an AP-Flow usage page.
- **Phase 19.2** — AP-Flow Google Drive folder intake: the item Phase 19 deferred. Per-org OAuth 2.0 + PKCE Drive connection (no `googleapis` SDK — hand-rolled `fetch`), AES-256-GCM-encrypted refresh tokens, a 5-minute poll, files imported at most once each through the same pipeline direct upload uses. **Superseded by Phase 19.3 below.**
- **Phase 19.3** — Drive folder intake promoted from AP-Flow to a platform integration (`/api/v1/integrations/drive`). Service-account authentication (RFC 7523 JWT-bearer, `node:crypto`, no SDK) alongside the retained OAuth path — no consent screen, no Google app verification, no refresh-token expiry. Many folders per org, each purposed `VENDOR_BILL` (→ AP-Flow) or `BANK_STATEMENT` (→ LedgerCore) and routed through a zero-SQL dispatcher (`driveIntakeDispatcher.ts`) that calls each app's own service, never its tables (rule 16). Poll tightened to ~60 seconds with a real incremental cursor and a claim-before-sync guard against overlap; the prior sweep's missing `last_synced_at` filter and a test-helper `resetTables()` gap (the Drive tables were never truncated) both fixed in the same pass.
- **Phase 19.4** — AP-Flow duplicate-content capture: a real bug found from using Phase 19.3 — a renamed re-upload of an already-captured invoice was silently absorbed into the original registration, with nothing new appearing anywhere. `ux_ap_flow_documents_document`'s unique constraint dropped; a repeat capture now lands as a new, visible `DUPLICATE` row with `duplicateOfId` pointing at the earlier one, no extraction enqueued until a human confirms it via the existing `POST /documents/:id/reextract` action. One function, `createApFlowDocument`, is the single place every entry point (direct upload, two-step registration, Drive sync) makes this decision.
- **Phase 6.1** — a half-step off Phase 6 (bank reconciliation), discovered mid-build, no renumbering (the 3.5–3.9 lineage). `POST /bank-transactions/:id/post-journal` closes Phase 6's one named gap: a bank line with no counterpart document (a fee, interest, an opening capital deposit) now settles by posting a journal entry directly instead of being forced through `IGNORE`, which was dropping real cash movement out of the reconciliation report. Migration 057 gives `bank_transactions` a second, mutually exclusive `MATCHED` shape (`matched_journal_entry_id`, an XOR CHECK against `matched_payment_id`); `unmatch` reverses the journal entry the same way it already voided a matched payment. Same phase also shipped **`walkthrough/`** — a committed, three-month, hand-enterable accounting scenario (Harbor Point Fabrication: vendor bills, customer invoices, three bank statements in three different bank formats, a `TUTORIAL.md` with inline hints and answers) with a computed answer key verified end-to-end against the real API, not just against its own arithmetic — `npm run walkthrough` regenerates it.
- **Phase 24** — a direct feature request, not part of the strategic-plan sequence that reserves 20–23 (see [docs/roadmap.md § phase numbering](docs/roadmap.md#phase-24-as-delivered) for why this is 24). LedgerCore gains a selectable, org-owned **payment-terms catalogue** (seven standards seeded per org) that derives an invoice/bill due date instead of one typed by hand, snapshotted onto the document rather than FK-referenced so a later rename can never reach a posted row; an **item/service catalogue** invoice and bill lines can be picked from (a catalogue, not inventory — no stock, no COGS), which copies its defaults into a line once rather than binding to it; and the Phase 9b staged migration importer extended with **`CUSTOMERS`/`VENDORS`** kinds, merging into an existing party by email-then-name match without ever overwriting data already present. A real `ON DELETE` FK-mode bug (copied from the wrong precedent) was caught by `guardrail-review` mid-build and corrected forward with a new migration. Also a money-totals spacing fix across several pages, and "Bill" relabelled "Expense" in the UI only (`/expenses/*` routes added, `/bills/*` kept as aliases; schema/API/types/tests unchanged). 1678 server + 280 client tests at the time.
- **Phase 25** — customer & vendor accounts: a clickable subsidiary ledger per party under the AR/AP control accounts (**no GL account per party**; statements unchanged), derived by attributing control-account lines through each invoice/bill/payment's `journal_entry_id`/`void_journal_entry_id` — no migration. `GET /customers|vendors/:id/ledger` and `/open-items`; per party, ledger closing = open-items outstanding, and Σ parties = aging total = control balance. Manual and bank-line journals to a control account are now refused (`422`, the SAP reconciliation-account rule); document posting and reversals are unaffected. 1702 server + 286 client tests at the time.
- **Phase 26** — credit notes (AR) and debit notes (AP, a.k.a. vendor credits): correcting documents that reference their original invoice/bill, copy its party/currency/frozen rate, post their own journal entry (`credit_note`: DR revenue/tax · CR AR; `debit_note`: DR AP · CR expense/tax), and settle documents through insert-only allocations alongside payments. Issue auto-applies to the original; a remainder is unapplied credit (a negative open item) applicable to another open document with no journal entry. Migration `063`; settlement redefined once in `settlementSql.ts`; `walkthrough/` gains month 4, "returns & adjustments". 1763 server + 296 client tests at the time.
- **Phase 27** — choosing apps: a new organization picks its apps on a post-sign-up picker (`/welcome`), the chooser shows only those, and Account → Apps adds or removes them (`GET`/`PUT /api/v1/organizations/apps`, migration `064` `organization_apps`, existing orgs backfilled with every app that existed at the time (seven — StockLedger came later)). The registry gains `requires` (five apps need `ledger-core`), checked on save. **Visibility only, not access control** — no app route checks it. Account also shows account-created, organization-created and joined dates. Study notes skipped at the user's direction (owed — see roadmap). 1799 server tests + 308 client tests at the time.
- **Phase 28** — StockLedger: a new, eighth app (`requires: []`, posts nothing to the GL), a direct feature request approving master-plan decision D1 for inventory only (ProcureFlow/MakeFlow/PeopleCost/AssetBook stay dropped). Ten industry-profile starting catalogues (code, copied into the org's own tables on `POST /stock/setup`); per-org custom item/serial attributes as JSONB, validated against a relational definitions table; a configurable item-code grammar (`{CAT}`/`{YYYY}`/`{YY}`/`{ATTR:key:n}`/`{SEQ:n}`) with per-scope-key gapless counters; QR label generation with a deliberately minimal scan payload (a route and a UUID, nothing business-identifying); perpetual inventory — moving average for `QUANTITY`/`LOT`, specific identification for `SERIAL` — over an append-only movement ledger with an integrity-checked derived balance cache (the platform's 5th integrity check); a serial status FSM; deterministic multi-row lock ordering keeping concurrent transfers deadlock-free (proven by a repeated-run concurrency test). Migrations `065`–`067`, 12 tables. **1969 server tests + 338 client tests** (current totals — full clean runs, zero regressions, 2 server tests skipped: the pre-existing gated live-provider cases; 168 server + 30 client are StockLedger's own). A formal guardrail review found zero violations; a real end-to-end browser smoke test passed all 8 milestones.
- **Phase 29** — a pure deletion phase: TaxGuard AI, FP&A Engine, UnitEcon, BoardDeck Automator and ForecasterPro (Phases 12, 13, 14, 15, 16) and the Phase 18 sandbox dataset removed from the suite in full — every server/client file, their queue handlers, their `reportService`/`types/ledger-core.ts` cross-app bridge functions, their env vars, and their five spec files. Migration `068_platform_drop_retired_apps.sql` drops the 20 tables the removed code built; migrations `033`–`047` stay on disk, unedited, per rule 13. The suite is now LedgerCore, AP-Flow and StockLedger — three apps. **1550 server tests passing (2 skipped) + 283 client tests passing (0 skipped)** at the time. A guardrail review over the complete diff found zero violations.

**Not built** — QuickBooks sync (deferred from Phase 9 to 17), and every deliberate scope gap each shipped phase carries (e.g. no partial void, no cash refund of unapplied credit, no bad-debt write-off, no year-end closing entry, no `audit_logs` retention, no Document Vault object storage, no AP-Flow 3-way matching, no PDF/XLSX export). **None of this is summarized here** — each phase's own "Deliberately not built" note lives in [docs/roadmap.md](docs/roadmap.md), and each app's own gaps in its spec file ([ledger-core.md](docs/ledger-core.md), [ap-flow.md](docs/ap-flow.md), [stock.md](docs/stock.md)) — read the relevant section before claiming a capability exists or doesn't. Five further apps' spec files (FP&A Engine, ForecasterPro, UnitEcon, BoardDeck Automator, TaxGuard AI) were deleted along with the apps in Phase 29 — see [docs/roadmap.md](docs/roadmap.md#phase-29-as-delivered).

**Phases were renumbered twice** — 2026-09-01 (everything downstream of Phase 5 shifted) and 2026-09-10 (QuickBooks deferred 9→17, Phases 9/9.5 inserted, 10–16 untouched). Old phase numbers cited anywhere are stale. Full mapping: [docs/roadmap.md § renumbering — 2026-09-01](docs/roadmap.md#phase-renumbering--2026-09-01) and [§ 2026-09-10](docs/roadmap.md#phase-renumbering--2026-09-10).

Migrations `033`–`047` remain on disk, unedited, per rule 13 — they still describe the 20 tables (`fpa_*`, `forecaster_*`, `unitecon_*`, `boarddeck_*`, `taxguard_*`, `sandbox_datasets`) that Phase 29's migration `068` dropped from the database. A fresh `npm run migrate` still creates all 20 and then drops them again.

`server/.env` still requires `ACCESS_TOKEN_SECRET` and `REFRESH_TOKEN_SECRET` — at least 32 chars and different from each other, or the server refuses to boot.

Dev model: Postgres + Redis in Docker; server, worker and client run on the host via `./dev.sh` (one command; `docs/development.md` keeps the per-terminal path). Still no Dockerfiles and no `entrypoint.sh`.

**Assume nothing in `docs/` is built unless it is listed above.** The rest is target state — check the filesystem before claiming any capability exists.

## Hard rules

Violating any of these is a bug, not a style choice. Full detail and code examples: [docs/guardrails.md](docs/guardrails.md).

1. **Every query is scoped by `org_id`.** No `org_id` predicate = tenant data leak. `user_id` is a `created_by` audit field, **never** an access check. Read the active org only from the verified access token — never a header, param, or body. The app slug in the URL is a routing namespace, not a tenancy boundary — see rule 16.
2. **No SQL in controllers.** Controllers validate input, call a service, format the response. All `pool.query` / `client.query` lives in `src/services/` — including auth and the app registry.
3. **Money is integer `BIGINT` cents.** Never floats, never `DECIMAL`. `isBalanced` is integer equality, never an epsilon comparison.
4. **Parameterized queries only** (`$1, $2`). Never interpolate into SQL — whitelist identifiers like sort columns against a constant map.
5. **Inside a transaction, every query uses the checked-out `client`.** A stray `pool.query` silently escapes the transaction. No post-`COMMIT` follow-up work — queue it.
6. **Posted financial documents are immutable.** Correct via reversing entries (`POST /:id/reverse`). No `PUT`/`DELETE` on a posted journal, invoice, receipt, or payroll run. From Phase 3 a `BEFORE UPDATE OR DELETE` trigger enforces this in the database too.
7. **A ledger line has exactly one side populated**, and an entry balances. Both sides > 0 is invalid; both zero is invalid. Enforce in the service *and* with a CHECK constraint; the entry-level balance is re-checked by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger at `COMMIT`.
8. **Every `*_id` gets a `REFERENCES` constraint** with explicit `ON DELETE`. Index every FK used in a join and every scope column.
9. **Emails lowercase on write**, backed by `UNIQUE (LOWER(email))`.
10. **Lifecycle status lives in one FSM transition table** in code. No ad-hoc status assignment scattered across services.
11. **Tokens:** `ACCESS_TOKEN_SECRET` (15m) and `REFRESH_TOKEN_SECRET` (7d). There is no `JWT_SECRET` — do not reintroduce it. Never log decoded payloads.
12. **Account types are exactly five:** `Asset`, `Liability`, `Equity`, `Revenue`, `Expense`. Never a sixth.
13. **Migrations:** `server/src/db/migrations/` only, sequential 3-digit prefix, additive and idempotent. **Never edit an applied migration.** Destructive changes need explicit sign-off. One shared sequence across every app — filenames tag the app: `NNN_<app-slug>_<subject>.sql`.
14. **No dependency before the phase that needs it.** No ORM. Redis-backed queueing (`bullmq` + `ioredis`) landed in Phase 7 — don't add a third queue-adjacent package (e.g. `rate-limit-redis`) speculatively. The blanket "no LLM" ruling is reversed for exactly one app: AP-Flow's vision extraction and classification (Phases 10, 19 — Anthropic SDK or Gemini over `fetch`, env-selected, no SDK for Gemini). No LLM/embeddings SDK outside that.
15. **Every module ships tests**, including a cross-tenant isolation test. Without one it is not done — one per app, not one for the whole suite.
16. **App boundaries are namespaces, not tenancy.** `org_id` is still the only access-control boundary inside an app's own routes. No app reads another app's tables directly — cross-app effects go through LedgerCore's GL via `source_type`/`source_id`. `config/apps.ts` is the single source of truth for which slugs exist.

## Standing task: study notes

The user is preparing for **Backend / React + Node.js + TypeScript** interviews. `study/` holds interview notes generated from this project's own decisions.

**Every change that introduces something new owes a study note in the same change** — a Node/Express mechanism, a TypeScript feature, a PostgreSQL feature, a React pattern, an architectural pattern, or a data-structure choice. Extend the existing note if the topic is already covered; create one from `study/TEMPLATE.md` if not. Update the index and coverage tracker in [study/README.md](study/README.md).

Notes need **mechanism-level depth** (how it works underneath, not what the API is), the **alternatives we rejected and why**, gotchas, and **4–8 interview questions with full written answers**. Accuracy outranks completeness — the user will repeat these in an interview, so state the version you verified against and flag anything you are unsure of. Convention: [docs/study-notes.md](docs/study-notes.md). Debt: some phases had notes explicitly skipped at the user's direction — check that phase's roadmap.md entry for what's owed before assuming coverage is complete.

## Docs

Read the relevant file before working — they are not in context by default.

| File | Read it when |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | Starting any work — phase order, gates, each app's DB pattern, and every phase's full delivered detail and gaps |
| [docs/ledger-core.md](docs/ledger-core.md) | Building any LedgerCore phase (3–4, 6, 8–9) — full feature spec, build ladder, acceptance criteria |
| [docs/ap-flow.md](docs/ap-flow.md) | Building AP-Flow (10–11) — the OCR/PII pipeline, COA mapping order, review queue |
| [docs/stock.md](docs/stock.md) | Building StockLedger (28) — the industry profiles, the code-pattern grammar, attribute rules, tracking/valuation rulings, the serial FSM, the lock-order rule, the QR payload |
| [docs/guardrails.md](docs/guardrails.md) | Writing any server code; also holds why the old build was scrapped |
| [docs/architecture.md](docs/architecture.md) | Touching auth, tenancy, RBAC, or the platform/app split; adding files (layer-first layout, module delivery order) |
| [docs/schema.md](docs/schema.md) | Writing a migration or a query — table definitions, constraints, default chart of accounts |
| [docs/api.md](docs/api.md) | Adding or changing a route — response shape, pagination, error conventions |
| [docs/development.md](docs/development.md) | Running the stack, env vars, Docker, adding a dependency |
| [docs/testing.md](docs/testing.md) | Writing tests — unit vs integration tiers and what each must cover |
| [docs/study-notes.md](docs/study-notes.md) | Writing a study note — required sections and the accuracy bar |
| [docs/master-plan.md](docs/master-plan.md) | Discussing product direction, new apps, or the business model — a **proposal**, nothing in it is built or approved |

## Keeping docs honest

The prior build's docs drifted from reality and the drift hid a structural problem until a rewrite was cheaper than a repair. When a change lands, update the affected doc in the same pass — `docs/api.md` for routes, `docs/schema.md` for tables, `docs/roadmap.md` for phase status. Claiming something works when it doesn't is worse than saying nothing. This file stays a short index on purpose — detail belongs in `docs/`, never duplicated here.
