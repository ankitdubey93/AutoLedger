# Build Roadmap & Module Map

Phases are sequential. Where a **Gate** is listed, do not start the gated work first — ask before reordering.

| Phase | Scope | Gate |
|---|---|---|
| **0** | Scaffold: `git init` + first commit, `server/` and `client/` skeletons, TS strict config, Dockerfiles, entrypoint, Vitest config, `.gitignore` (incl. `coverage/`), drop legacy `JWT_SECRET`, rewrite `README.md` | Blocks everything |
| **1** | Identity + tenancy: migration runner, `organizations`, `users`, `organization_members`, `refresh_tokens`; `authService`; register/login/refresh/logout/switch-org; auth + RBAC middleware | Blocks everything below |
| **2** | GL core: chart of accounts, journal entries (create/list), reversing entries, trial balance — all `org_id` scoped, all `BIGINT` cents | Blocks 3+ |
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
