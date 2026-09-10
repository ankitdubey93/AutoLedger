# AutoLedger

A suite of seven portfolio applications sharing one multi-tenant platform: PostgreSQL + Express/TypeScript + React. One identity/tenancy layer, one login, an app chooser — then each app is its own accounting or engineering skill demo.

| App | Domain | Core skills |
|---|---|---|
| LedgerCore | Core Accounting & Systems | Double-entry enforced by DB trigger, immutable ledger, multi-currency FX, bank reconciliation, QuickBooks API sync |
| TaxGuard AI | Compliance & AI Workflows | RAG, vector databases, tax act parsing |
| AP-Flow | Operational Accounting | Multimodal OCR invoice parsing, PII pixel masking, history-driven COA mapping, human-in-the-loop review |
| FP&A Engine | Financial Modeling | 3-statement linking, scenario modeling, cash runway forecasting |
| UnitEcon | Commercial Analytics | Cohort retention matrices, LTV/CAC ratios, Price-Volume-Mix variance |
| BoardDeck Automator | Board Reporting & Close | Monthly close automation, BvA variance, automated `.pptx` deck generation |
| ForecasterPro | Budgeting & Planning | Driver-based rolling forecasting, headcount planning, zero-based budgeting |

Double-entry accounting is the suite's system of record: LedgerCore is the General Ledger every other app posts into, rather than each app keeping its own private notion of money. All amounts are integer `BIGINT` cents; all business data is scoped to an `organization`.

## Status — Phase 10 complete (AP-Flow capture & extraction)

Auth, tenancy, the app registry, **LedgerCore's general ledger through multi-currency FX, bank reconciliation and a staged migration importer**, the shared CDC audit trail, background jobs & webhooks, the platform Document Vault, and **AP-Flow's first module — capture & extraction** all work. The other five apps are `'planned'` — visible on the chooser, no routes behind them.

| Built | Not built |
|---|---|
| Express + TypeScript server, strict compiler config; migrations, auth, tenancy, RBAC, org switching (Phases 0–1) | QuickBooks Online sync (Phase 17, deferred from 9) |
| App registry + chooser: `GET /api/v1/apps`, `/`, `/app/:appSlug` (Phase 2) | AP-Flow's mapping, review queue & posting — extraction produces a draft only (Phase 11) |
| **LedgerCore (Phases 3–4, 6, 8, 9): GL core, live financial statements with fiscal period close/lock, bank reconciliation, multi-currency FX, and a staged chart/opening-balance importer — the balance invariant and immutability enforced by database triggers throughout** | FP&A Engine, UnitEcon, BoardDeck Automator, ForecasterPro, TaxGuard AI — no routes yet (Phases 12–16) |
| Onboarding, settings, dashboard, journal register, account ledgers, sales invoicing, accounts payable with settlement (Phases 3.5–3.9) | |
| The shared CDC audit trail (Phase 5); background jobs, the transactional outbox, and financial-event webhooks (Phase 7) | |
| Platform onboarding state and LedgerCore's data-migration importer (Phase 9); the platform Document Vault — org-scoped, content-addressed file storage shared across apps (Phase 9.5) | |
| **AP-Flow (Phase 10): local OCR, checksum-verified PII pixel masking before any image reaches an external model, then Claude Vision extraction into a structured draft with per-field confidence — posts nothing to the ledger yet** | |
| React + Vite client: login/register, app chooser, account page, the Document Vault, LedgerCore's full page set, AP-Flow's capture pages | |
| Vitest — see [docs/roadmap.md](docs/roadmap.md#phase-10-as-delivered) for the current test count | |

Nothing under `docs/` describes working code unless this table says so — it is target-state design. See [docs/roadmap.md](docs/roadmap.md).

## Running it

PostgreSQL and Redis run in Docker. The server and client run on the host, each in its own terminal.

Requires Node 22+ and Docker.

```bash
# once
cp .env.example .env                  # docker-compose credentials
cp server/.env.example server/.env
cp client/.env.example client/.env
(cd server && npm install)
(cd client && npm install)

# infrastructure
docker compose up -d                  # postgres :5432, redis :6379
```

```bash
# terminal 1
cd server && npm run dev              # http://localhost:5000

# terminal 2
cd client && npm run dev              # http://localhost:5173
```

Open http://localhost:5173 — register an organization and you land on the app chooser.

```bash
curl http://localhost:5000/api/v1/health
```

Full detail, including environment variables and the dependency policy: [docs/development.md](docs/development.md).

## Tests

```bash
cd server
npm test              # unit + integration
npm run test:coverage
```

Integration tests need the Postgres container running. Every module ships a cross-tenant isolation test from Phase 1 onward, one per app — see [docs/testing.md](docs/testing.md).

## Layout

```text
server/     Express + TypeScript API — controllers / services / routes / middleware / db
            platform code (auth, organizations, apps) is unprefixed; each app's
            code nests under an <app-slug>/ subfolder in every layer
client/     React + Vite frontend — same platform-vs-app split under Pages/
docs/       Architecture, schema, API, guardrails, roadmap
study/      Interview-prep notes generated from this project's decisions
```

## Documentation

| File | Contents |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | Phase order, gates, per-app DB patterns |
| [docs/ledger-core.md](docs/ledger-core.md) | LedgerCore's full spec and build ladder |
| [docs/ap-flow.md](docs/ap-flow.md) | AP-Flow's OCR/PII pipeline spec |
| [docs/guardrails.md](docs/guardrails.md) | The 16 non-negotiable engineering rules |
| [docs/architecture.md](docs/architecture.md) | Suite structure, tenancy model, RBAC, repository layout |
| [docs/schema.md](docs/schema.md) | Table definitions and constraints |
| [docs/api.md](docs/api.md) | Route surface and response conventions |
| [docs/development.md](docs/development.md) | Running the stack, env vars, dependencies |
| [docs/testing.md](docs/testing.md) | Test tiers and what each must cover |
| [study/README.md](study/README.md) | Study-note index and coverage tracker |
