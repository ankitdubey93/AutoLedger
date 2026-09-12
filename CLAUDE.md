# AutoLedger — CLAUDE.md

AutoLedger is a suite, not one app: a shared identity/tenancy platform hosting **seven portfolio applications**, each demonstrating a different accounting or engineering skill.

| App | Slug | Domain | Core skills |
|---|---|---|---|
| LedgerCore | `ledger-core` | Core Accounting & Systems | Double-entry enforced by DB trigger, immutable ledger, multi-currency FX, bank reconciliation with confidence matching, QuickBooks API sync — [docs/ledger-core.md](docs/ledger-core.md) |
| TaxGuard AI | `taxguard` | Compliance & AI Workflows | RAG over `pgvector`, tax act parsing, PII-redacted question answering with citations — [docs/taxguard.md](docs/taxguard.md) |
| AP-Flow | `ap-flow` | Operational Accounting | Multimodal OCR invoice parsing, PII pixel masking, history-driven COA mapping, human-in-the-loop review — [docs/ap-flow.md](docs/ap-flow.md) |
| FP&A Engine | `fpa-engine` | Financial Modeling | 3-statement linking, scenario modeling, cash runway forecasting — [docs/fpa-engine.md](docs/fpa-engine.md) |
| UnitEcon | `unitecon` | Commercial Analytics | Cohort retention matrices, LTV/CAC ratios, Price-Volume-Mix variance — [docs/unitecon.md](docs/unitecon.md) |
| BoardDeck Automator | `boarddeck` | Board Reporting & Close | Monthly close automation, BvA variance, automated `.pptx` deck generation — [docs/boarddeck.md](docs/boarddeck.md) |
| ForecasterPro | `forecaster` | Budgeting & Planning | Driver-based rolling forecasting, headcount planning, zero-based budgeting — [docs/forecaster.md](docs/forecaster.md) |

All seven apps have real routes (`status: 'building'` in `server/src/config/apps.ts`) — TaxGuard AI was the last to flip, in Phase 16.

## State: Phase 18 done — the sandbox dataset: one-click 24-month demo data across all seven apps

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
- **Phase 12** — FP&A Engine's linked 3-statement model: scenarios, integer-basis-point assumptions, a pure projection engine.
- **Phase 13** — ForecasterPro: driver-based rolling forecasts, headcount planning, zero-based budgeting with an approval freeze.
- **Phase 14** — UnitEcon: cohort retention matrices, LTV/CAC from configured acquisition accounts, Price-Volume-Mix variance at revenue-account grain.
- **Phase 15** — BoardDeck Automator: five-check monthly close readiness against a LedgerCore fiscal period, budget-vs-actual at board-section grain, background-job `.pptx` deck generation.
- **Phase 16** — TaxGuard AI: tax act PDF ingestion (`pgvector`-backed corpus, background-job embedding), retrieval-grounded cited answers, question redaction before any provider call. 1370 server + 234 client tests at the time (see [docs/roadmap.md](docs/roadmap.md#phase-16-as-delivered)).
- **Phase 18** — the sandbox dataset: a one-click, 24-month demo across all seven apps, seeded through the real services (`invoiceService.createInvoice`, `billService.approveBill`, `bankMatchService.matchTransaction`, …) so every trigger, FSM and audit row fires genuinely. `POST /api/v1/sandbox/load`, `npm run seed:demo`, and an `OWNER`-only card on the app chooser. **1394 server tests + 244 client tests** (current totals; see [docs/roadmap.md](docs/roadmap.md#phase-18-as-delivered)). (Phase 17, QuickBooks, stays deferred and unbuilt.)

**Not built** — QuickBooks sync (deferred from Phase 9 to 17), and every deliberate scope gap each shipped phase carries (e.g. no credit notes/vendor credits/partial void, no year-end closing entry, no `audit_logs` retention, no Document Vault object storage, no AP-Flow 3-way matching, no FP&A scenario cloning, no ForecasterPro formula language, no UnitEcon SKU-level dimension or churn model, no BoardDeck deck template/branding, no PDF/XLSX export, no TaxGuard in-place re-ingest or measured retrieval-precision figure). **None of this is summarized here** — each phase's own "Deliberately not built" note lives in [docs/roadmap.md](docs/roadmap.md), and each app's own gaps in its spec file ([ledger-core.md](docs/ledger-core.md), [ap-flow.md](docs/ap-flow.md), [fpa-engine.md](docs/fpa-engine.md), [forecaster.md](docs/forecaster.md), [unitecon.md](docs/unitecon.md), [taxguard.md](docs/taxguard.md)) — read the relevant section before claiming a capability exists or doesn't.

**Phases were renumbered twice** — 2026-09-01 (everything downstream of Phase 5 shifted) and 2026-09-10 (QuickBooks deferred 9→17, Phases 9/9.5 inserted, 10–16 untouched). Old phase numbers cited anywhere are stale. Full mapping: [docs/roadmap.md § renumbering — 2026-09-01](docs/roadmap.md#phase-renumbering--2026-09-01) and [§ 2026-09-10](docs/roadmap.md#phase-renumbering--2026-09-10).

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
6. **Posted financial documents are immutable.** Correct via reversing entries (`POST /:id/reverse`). No `PUT`/`DELETE` on a posted journal, invoice, receipt, or payroll run. From Phase 3 a `BEFORE UPDATE OR DELETE` trigger enforces this in the database too.
7. **A ledger line has exactly one side populated**, and an entry balances. Both sides > 0 is invalid; both zero is invalid. Enforce in the service *and* with a CHECK constraint; the entry-level balance is re-checked by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger at `COMMIT`.
8. **Every `*_id` gets a `REFERENCES` constraint** with explicit `ON DELETE`. Index every FK used in a join and every scope column.
9. **Emails lowercase on write**, backed by `UNIQUE (LOWER(email))`.
10. **Lifecycle status lives in one FSM transition table** in code. No ad-hoc status assignment scattered across services.
11. **Tokens:** `ACCESS_TOKEN_SECRET` (15m) and `REFRESH_TOKEN_SECRET` (7d). There is no `JWT_SECRET` — do not reintroduce it. Never log decoded payloads.
12. **Account types are exactly five:** `Asset`, `Liability`, `Equity`, `Revenue`, `Expense`. Never a sixth.
13. **Migrations:** `server/src/db/migrations/` only, sequential 3-digit prefix, additive and idempotent. **Never edit an applied migration.** Destructive changes need explicit sign-off. One shared sequence across every app — filenames tag the app: `NNN_<app-slug>_<subject>.sql`.
14. **No dependency before the phase that needs it.** No ORM. Redis-backed queueing (`bullmq` + `ioredis`) landed in Phase 7 — don't add a third queue-adjacent package (e.g. `rate-limit-redis`) speculatively. The blanket "no LLM" ruling is reversed for exactly two apps: AP-Flow's vision extraction (Phase 10) and TaxGuard AI's RAG (Phase 16). No LLM/embeddings SDK outside those.
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
| [docs/fpa-engine.md](docs/fpa-engine.md) | Building FP&A Engine (12) — the projection engine's arithmetic, assumption kinds, the rule-16 LedgerCore boundary |
| [docs/forecaster.md](docs/forecaster.md) | Building ForecasterPro (13) — driver/line/headcount arithmetic, the rolling mechanism, zero-based budgeting and approval-freeze rulings, the rule-16 boundary |
| [docs/unitecon.md](docs/unitecon.md) | Building UnitEcon (14) — cohort arithmetic, the LTV/CAC formulas, the PVM decomposition and its rounding ruling, the rule-16 boundary |
| [docs/boarddeck.md](docs/boarddeck.md) | Building BoardDeck Automator (15) — the five close checks, the BvA section summarizer, the async deck-generation lifecycle, the rule-16 boundary |
| [docs/taxguard.md](docs/taxguard.md) | Building TaxGuard AI (16) — the chunking/citation rules, the retrieval formula, the answer contract, the PII-redaction ordering ruling, the rule-16 boundary |
| [docs/guardrails.md](docs/guardrails.md) | Writing any server code; also holds why the old build was scrapped |
| [docs/architecture.md](docs/architecture.md) | Touching auth, tenancy, RBAC, or the platform/app split; adding files (layer-first layout, module delivery order) |
| [docs/schema.md](docs/schema.md) | Writing a migration or a query — table definitions, constraints, default chart of accounts |
| [docs/api.md](docs/api.md) | Adding or changing a route — response shape, pagination, error conventions |
| [docs/development.md](docs/development.md) | Running the stack, env vars, Docker, adding a dependency |
| [docs/testing.md](docs/testing.md) | Writing tests — unit vs integration tiers and what each must cover |
| [docs/study-notes.md](docs/study-notes.md) | Writing a study note — required sections and the accuracy bar |

## Keeping docs honest

The prior build's docs drifted from reality and the drift hid a structural problem until a rewrite was cheaper than a repair. When a change lands, update the affected doc in the same pass — `docs/api.md` for routes, `docs/schema.md` for tables, `docs/roadmap.md` for phase status. Claiming something works when it doesn't is worse than saying nothing. This file stays a short index on purpose — detail belongs in `docs/`, never duplicated here.
