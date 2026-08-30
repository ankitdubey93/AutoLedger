# Build Roadmap & Module Map

Phases are sequential. Where a **Gate** is listed, do not start the gated work first — ask before reordering.

| Phase | Scope | Gate |
|---|---|---|
| **0 ✅ done** | Scaffold — see [Phase 0, as delivered](#phase-0-as-delivered) below | Blocks everything |
| **1 ✅ done** | Identity + tenancy — see [Phase 1, as delivered](#phase-1-as-delivered) below | Blocks everything below |
| **2** | GL core: chart of accounts, journal entries (create/list), reversing entries, trial balance — all `org_id` scoped, all `BIGINT` cents. **Also owes: seed the default chart at registration, plus a backfill for organizations created during Phase 1** ([schema.md](schema.md)) | Blocks 3+ |
| **3** | GL completion: fiscal periods with close/lock, P&L, balance sheet, AR/AP subledgers | |
| **4** | CDC audit trail: `audit_logs` JSONB table, `OLD`/`NEW` snapshot triggers on all financial tables | Blocks compliance claims |
| **5** | Background jobs: `bullmq` + `ioredis`, Redis healthcheck + `depends_on`, worker process, retry/DLQ policy | Blocks 9, 11, 12, 13 |
| **6** | Master data: customers, vendors, products/items, tax codes, units of measure | Blocks 7, 8, 9 |
| **7** | Inventory & WMS | Blocks 8, 10 |
| **8** | Procurement / P2P | |
| **9** | Sales & Invoicing / O2C, incl. idempotency middleware + PDF workers | Needs 5 |
| **10** | Manufacturing / MRP | Needs 7 |
| **11** | HR & Payroll | Needs 5 |
| **12** | CRM, QMS, EAM | |
| **13** | Multi-currency FX engine | Needs 5 |
| **14** | Document processing: presigned uploads + OCR | |
| **15** | MagicJournal NL assistant — DB-backed corpus, `org_id` scoped | |

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

**Also not built, and not owed until later:** `react-router-dom` (Phase 1, with the second page), `utils/money.ts` (Phase 2, with the first money column), `types/express.d.ts` and `req.user` (Phase 1), the migration runner and `npm run migrate` / `db:reset` (Phase 1).

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
| `register` seeds the chart of accounts | Deferred to Phase 2 | `accounts` is a Phase 2 table. Phase 2 inherits a backfill obligation |
| `refresh_tokens.token` | `refresh_tokens.token_hash` | A dump of the table must not yield usable sessions |
| — | Added `GET /organizations/members` | Phase 1 otherwise has no org-scoped table, so the mandatory cross-tenant isolation test would have had nothing to test and `rbac.ts` nothing to guard |

**Known gaps, deliberate:** no login rate limiting (`express-rate-limit` is a scheduled decision in [development.md](development.md)); no email verification (columns exist, nothing writes them); a revoked membership stays effective for up to 15 minutes, which is the trade the short access-token TTL buys ([architecture.md](architecture.md)).

---

## Module map

The domain and DB pattern intended for each module. All planned; none built.

### Finance & General Ledger — Phases 2–3

The immutable source of truth. Strict double-entry validation inside `BEGIN...COMMIT`, all amounts integer cents. Every other module posts journal entries here via `source_type` / `source_id`.

*Includes:* chart of accounts, manual journal entries, reversing entries, trial balance, fiscal periods with close/lock, P&L, balance sheet, AR/AP subledgers.

### Inventory & Warehouse Management (WMS) — Phase 7

Multi-location stock tracking, FIFO/WAC valuation, bin-level routing.

*Pattern:* pessimistic locking (`SELECT ... FOR UPDATE`) on stock rows during checkout to prevent overselling under concurrency. Stock movements are an append-only ledger mirroring the GL — **current quantity is derived, never a mutable counter**.

### Procurement (Procure-to-Pay) — Phase 8

Requisitions, purchase orders, goods receipts, vendor invoicing.

*Pattern:* FSM-enforced status progression; automated 3-way matching across PO, receipt, and invoice.

### Sales & Invoicing (Order-to-Cash) — Phase 9

Customer orders, fulfillment tracking, tax calculation.

*Pattern:* idempotency-key middleware on all financial mutations, so a retried request after a network drop cannot double-bill. BullMQ workers for CPU-bound PDF invoice generation.

### Manufacturing (MRP) & Bill of Materials — Phase 10

Multi-tier BOMs, work orders, raw material conversion.

*Pattern:* `WITH RECURSIVE` CTEs to resolve deeply nested component trees in a single query. **Cycle detection is mandatory** — a BOM that contains itself must be rejected at write time.

### Human Resources & Payroll — Phase 11

Employee profiles, attendance, leave, salary generation.

*Pattern:* batch processing via cron-triggered BullMQ jobs. `EXCLUDE USING GIST` constraints make overlapping leave date ranges physically impossible at the DB layer (requires `btree_gist`).

### Quality Management System (QMS) — Phase 12

Incoming goods inspections, checklists, quarantine holds.

*Pattern:* customer-definable inspection forms stored as `JSONB`, validated in Node with `Ajv`. Schema versions are stored alongside submissions so old records stay interpretable.

### CRM & Lead Pipeline — Phase 12

Deals, contacts, top-of-funnel activity.

*Pattern:* full-text and fuzzy search via `pg_trgm` trigram indexes.

### Equipment Asset Management (EAM) — Phase 12

Fixed asset register and depreciation schedules.

*Pattern:* nightly cron job computes depreciation and auto-posts balancing journal entries to the GL. **Must be idempotent** — running twice for the same date posts once.

---

## Cross-cutting infrastructure

**Audit trail & CDC (Phase 4).** System-wide PostgreSQL triggers capturing `OLD` and `NEW` row states into a centralized, immutable `audit_logs` table as `JSONB`, alongside `org_id`, actor `user_id`, table name, operation, and timestamp. This is distinct from `updated_at` timestamp triggers — write both, but do not confuse one for the other. No compliance claim is valid until this lands.

**Multi-currency FX (Phase 13).** Background workers poll external rate APIs; realized and unrealized FX gain/loss computed on payment settlement. Rates are stored with their effective date and **never re-fetched retroactively** for historical transactions.

**Document processing (Phase 14).** Presigned-URL uploads to S3 / Cloudflare R2; async OCR (Tesseract or AWS Textract) in Node workers for receipt parsing.

---

## Deferred / out of scope

**MagicJournal (Phase 15).** The prior build shipped a local rule-based keyword-scoring engine that drafted journal entries from plain English, trained on a runtime-appended CSV. It worked, but it was a convenience feature on an unsound foundation, and its training corpus was a tracked file mutated at runtime (permanent version-control churn). Deliberately deferred to the end. If it returns, the corpus lives in a **database table scoped by `org_id`**, never a tracked CSV.

**LLM integration — out of scope.** No LLM integration is planned. Do not add an LLM dependency, API key, or provider SDK without an explicit decision recorded here first.
