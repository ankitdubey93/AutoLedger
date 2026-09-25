# AutoLedger

A full-suite accounting and bookkeeping application — sales, purchases, banking, inventory and reporting in one product — built on PostgreSQL + Express/TypeScript + React. Multi-tenant from the first migration: every row belongs to an organization, and one person can work across several.

What it covers, in the order the sidebar shows it:

| Area | What you can do |
|---|---|
| **Sales** | Invoices with templates and payment terms, credit notes, customers with a subsidiary ledger, payments with settlement |
| **Purchases** | Expenses (bills) with an approval workflow, debit notes, vendors — and a **Bill inbox**: upload or drop a bill in a Drive folder, it is OCR'd locally, personal data is masked on the pixels before any AI model sees it, and the bill is extracted, GL-coded and posted (automatically when confident, after review when not) |
| **Products & inventory** | One product master; perpetual inventory with moving-average and specific-identification costing, industry templates, configurable item codes, QR labels. Bills receive stock and invoices post cost of goods sold. Optional — nothing to set up if you don't keep stock |
| **Banking** | CSV statement import with configurable columns and date formats, confidence-scored matching, a reconciliation queue, direct posting for fees and interest |
| **Accounting** | Chart of accounts, journals with reversals, fiscal periods with close/lock, multi-currency with realized and unrealized FX |
| **Reports** | Profit & loss, balance sheet, trial balance, AR/AP aging, FX exposure |

Underneath: double-entry enforced by database triggers (an unbalanced or edited posted entry cannot exist), integer-cent money everywhere, a CDC audit trail on every financial table, and `npm run verify:integrity` to prove the books balance.

## Status

One product since Phase 33 (2026-09-25). It was built as three separately chosen apps (LedgerCore, AP-Flow, StockLedger), which are now its accounting, capture (bill inbox) and inventory modules; see [docs/roadmap.md](docs/roadmap.md#phase-33-as-delivered).

| Built | Not built |
|---|---|
| Identity, tenancy, RBAC, org switching; one setup wizard | QuickBooks Online sync (Phase 17, deferred) |
| Accounting: GL, statements, periods, bank reconciliation, multi-currency FX, invoices, bills, payments, credit/debit notes, customer & vendor subsidiary ledgers, staged data import | Lot/serial items and fixed assets on invoice/bill lines, depreciation (Phase 32 step 2) |
| Bill inbox: local OCR, PII pixel masking, Claude or Gemini extraction, history-first GL coding, review queue, confidence-gated auto-post, Google Drive intake | PDF/XLSX export, emailed documents |
| Inventory: perpetual valuation posting to the GL, templates, item codes, QR labels | Statutory tax engine (GST/VAT returns) |
| CDC audit trail, background jobs, outbox + webhooks, Document Vault, AI cost metering | Deployment (no Dockerfiles yet) |
| 1610 server tests, 428 client tests — see [docs/roadmap.md](docs/roadmap.md) for the current count | |

Nothing under `docs/` describes working code unless this table says so. See [docs/roadmap.md](docs/roadmap.md) for the full phase-by-phase record.

## Running it

PostgreSQL and Redis run in Docker. The server, worker and client run on the host, via one command.

Requires Node 22+ and Docker.

```bash
# once
cp .env.example .env                  # docker-compose credentials
cp server/.env.example server/.env
cp client/.env.example client/.env
(cd server && npm install)
(cd client && npm install)

# every session
./dev.sh                              # postgres :5432, redis :6379, migrations, server, worker, client
```

Open http://localhost:5173 — register an organization and the setup wizard takes you to the dashboard.

Setting up a machine from scratch — installing Node and Docker, generating the token secrets, restoring data? [SETUP.md](SETUP.md) walks through the whole thing.

Prefer a terminal per process, or need the test cluster? See [docs/development.md](docs/development.md) for the manual path.

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

Integration tests need the Postgres container running. Every module ships a cross-tenant isolation test from Phase 1 onward — see [docs/testing.md](docs/testing.md).

## Layout

```text
server/     Express + TypeScript API — controllers / services / routes / middleware / db
            platform code (auth, organizations, onboarding) is unprefixed; each
            module's code nests under accounting/, capture/ or inventory/ in every layer
client/     React + Vite frontend — one shell, one route table (src/routes/),
            pages grouped by sidebar section under Pages/
walkthrough/ Phase 6.1's demo scenario — human-readable JSON/CSV, manually enterable;
            used to verify the real services end-to-end
docs/       Architecture, schema, API, guardrails, roadmap
study/      Interview-prep notes generated from this project's decisions
```

## Documentation

| File | Contents |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | Phase order, gates, per-module DB patterns |
| [docs/accounting.md](docs/accounting.md) | Accounting module spec and build ladder |
| [docs/capture.md](docs/capture.md) | Bill inbox: the OCR/PII capture pipeline spec |
| [docs/inventory.md](docs/inventory.md) | Inventory module spec |
| [docs/guardrails.md](docs/guardrails.md) | The 16 non-negotiable engineering rules |
| [docs/architecture.md](docs/architecture.md) | Product structure, tenancy model, RBAC, repository layout |
| [docs/schema.md](docs/schema.md) | Table definitions and constraints |
| [docs/api.md](docs/api.md) | Route surface and response conventions |
| [docs/development.md](docs/development.md) | Running the stack, env vars, dependencies |
| [docs/testing.md](docs/testing.md) | Test tiers and what each must cover |
| [study/README.md](study/README.md) | Study-note index and coverage tracker |
