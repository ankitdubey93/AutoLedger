# Database Schema

**Applied: `001`–`075`.** Every phase's tables below are marked `— applied` except **Phase 17** (QuickBooks sync), which stays target state — deferred, unbuilt. This line was last correct at `026`; it drifted for a long stretch before an earlier pass caught it — the reminder to re-verify it against `server/src/db/migrations/` on every schema-touching change rather than trusting it by inertia, which is exactly why it's already been re-verified since. `033`–`047` are **retired** (Phase 29, migration `068`) — they stay applied and on disk under rule 13, but the 20 tables they built no longer exist. See [§ Phase 29 — five apps retired](#phase-29--five-apps-retired-platform--applied) below.

Apply with `npm run migrate`; rebuild from scratch with `npm run db:reset`. The runner records a SHA-256 checksum per file and **refuses to run if an applied migration has been edited** — rule 13 is enforced by the tooling, not by memory.

Migrations live in `server/src/db/migrations/` **only**, applied in sorted filename order — one shared sequence across every app in the suite, not one per app.

## Table naming across modules

AutoLedger is one product (Phase 33) with three modules sharing one database and one migration sequence. Table prefixes date from when the modules were separate apps and are **kept deliberately** — renaming them would touch every query, every audit trigger and the append-only audit history for no behavioural gain:

- **Accounting is unprefixed** (`accounts`, `journal_entries`, `ledger_lines`, `invoices`, `bills`, …) plus `ledger_settings`/`ledger_invoice_settings` — it is the system of record the other modules post into, the same reason `organizations` and `users` are unprefixed platform tables.
- **Capture** (the bill inbox, formerly AP-Flow) owns `ap_flow_*`; **inventory** (formerly StockLedger) owns `stock_*`. A module's tables are never read by another module directly — cross-module effects go through the owning module's service, and GL effects through `source_type` / `source_id`.
- `app_slug` columns (`audit_logs`, `outbox_events`, `onboarding_states`, `document_links`, `ai_model_calls`) and `integration_drive_files.result_app` hold a **frozen module provenance tag** — `ledger-core`, `ap-flow`, `stock` or `platform` — from `server/src/config/modules.ts`. The API exposes them as `module`.

Migration filenames tag the module they belong to with its historical slug: `NNN_<tag>_<subject>.sql`, e.g. `002_ledger-core_accounts.sql`. Platform migrations carry `platform` or no tag.

## Migration rules

- Strict sequential 3-digit prefix, app tag, descriptive suffix: `001_organizations_and_users.sql` (platform), `002_ledger-core_accounts.sql`. No gaps, no branches.
- **Additive and idempotent.** Use `IF NOT EXISTS` / `IF EXISTS`. **Never edit an applied migration** — write a new one.
- Data-destructive changes (dropping a column, narrowing a type) require explicit sign-off before being written.
- Money columns are `BIGINT` cents. No `DECIMAL` money, ever.
- `org_id UUID NOT NULL REFERENCES organizations(id)` on every domain table.
- Every FK declared with an explicit `ON DELETE`.
- Index every scope column and every FK used in a join.
- Reuse the shared `set_updated_at()` trigger function rather than defining another.

---

## Phase 1 — Identity & tenancy ✅ applied

`schema_migrations (version PK, filename, checksum, applied_at)` is created by the runner itself, not by a migration file.

**`organizations`** — the tenant boundary
`id` UUID PK DEFAULT `gen_random_uuid()` · `name` TEXT NOT NULL CHECK non-blank · `slug` TEXT UNIQUE NOT NULL · `base_currency` CHAR(3) NOT NULL DEFAULT `'USD'` CHECK `~ '^[A-Z]{3}$'` · `tax_number` TEXT nullable (Phase 3.8) · `business_number` TEXT nullable (Phase 3.8) · `created_at` · `updated_at`

The currency CHECK is not decoration: `CHAR(3)` alone accepts `'usd'`, `'123'` and `'   '`.

`tax_number`/`business_number` (migration `006_platform_organization_tax_ids.sql`) are nullable with no format CHECK — identifier formats differ per jurisdiction. Platform fields, edited via `PATCH /organizations`; whether they print on a LedgerCore invoice is `ledger_invoice_settings.show_tax_number`/`show_business_number`, a separate app-owned choice.

**`users`** — global identity, no `org_id`
`id` UUID PK · `name` TEXT · `email` TEXT NOT NULL · `password` TEXT NOT NULL (bcrypt) · `email_verified` BOOLEAN NOT NULL DEFAULT false · `email_verification_token` TEXT · `email_verification_token_expires` TIMESTAMPTZ · `created_at` · `updated_at`
Constraint: `UNIQUE (LOWER(email))` via `ux_users_email_lower`.

The three `email_verification*` columns exist but **nothing writes them**. There is no mailer and no verify endpoint, and login deliberately does not check `email_verified`. Generating a token nobody can redeem would be dead scaffolding; they are wired up in a later phase.

**`organization_members`** — membership + role
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `user_id` UUID NOT NULL FK → `users` ON DELETE CASCADE · `role` TEXT NOT NULL CHECK IN (`OWNER`,`ADMIN`,`ACCOUNTANT`,`VIEWER`) · `created_at`
Constraint: `UNIQUE (org_id, user_id)`. Index `idx_org_members_user_id` on `user_id`.

**`refresh_tokens`**
`id` UUID PK · `user_id` UUID NOT NULL FK → `users` ON DELETE CASCADE · `token_hash` TEXT UNIQUE NOT NULL · `org_id` UUID FK → `organizations` ON DELETE CASCADE (nullable) · `expires_at` TIMESTAMPTZ NOT NULL · `created_at`
Indexes: `idx_refresh_tokens_user_id`, `idx_refresh_tokens_expires_at`.

Two deliberate differences from the original plan:

- **`token_hash`, not `token`.** The column stores a SHA-256 digest, so a database dump yields no usable sessions. A fast hash is correct here — the token is a 200+ bit random value, and bcrypt exists to slow down guessing of *low*-entropy human passwords.
- **`org_id`** carries the session's active organization, so a rotated access token lands in the same org. Nullable, and a *hint* rather than a tenant scope — this table is org-less in the same sense `users` is.

**Trigger:** `set_updated_at()` fires `BEFORE UPDATE` on `organizations` and `users`.

---

## Phase 3 — General Ledger (LedgerCore, now accounting) ✅ applied

**`accounts`** — chart of accounts, per organization
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `code` TEXT NOT NULL · `name` TEXT NOT NULL · `type` TEXT NOT NULL CHECK IN (`Asset`,`Liability`,`Equity`,`Revenue`,`Expense`) · `parent_id` UUID FK → `accounts` ON DELETE RESTRICT (nullable) · `is_postable` BOOLEAN NOT NULL DEFAULT true · `description` TEXT · `is_active` BOOLEAN NOT NULL DEFAULT true · `created_by` UUID FK → `users` ON DELETE RESTRICT (nullable — the seed has no actor) · `created_at` · `updated_at`

Constraints:
- `UNIQUE (org_id, code)`
- `chk_account_not_own_parent` — `parent_id IS NULL OR parent_id <> id`

Index on `(org_id, code)` (the unique constraint serves it), `(org_id, parent_id)`, and `parent_id`.

`parent_id` is a self-referencing FK giving the chart a tree: `1000 Assets → 1100 Current Assets → 1110 Operating Cash`. Two rules the column alone cannot express are enforced in `accountService` and covered by tests: **a parent must belong to the same organization and carry the same `type`** (an Expense cannot hang under Assets), and **the graph must stay acyclic** (checked with a `WITH RECURSIVE` walk before an update is accepted). A single-column CHECK stops only the trivial self-parent case, which is why it is the only one in the DDL.

`is_postable` separates header accounts from leaves. `1000 Assets` is a rollup for reporting and must never receive a posting; `1110 Operating Cash` must. A trigger on `ledger_lines` rejects a line whose account has `is_postable = false` — the same "the database is the guardrail" posture as the balance check.

**`journal_entries`** — transaction headers, **immutable once written**
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` **ON DELETE RESTRICT** · `created_by` UUID NOT NULL FK → `users` ON DELETE RESTRICT · `entry_date` DATE NOT NULL · `description` TEXT · `source_type` TEXT NOT NULL DEFAULT `'manual'` · `source_id` UUID · `reverses_entry_id` UUID FK → `journal_entries` ON DELETE RESTRICT · `created_at`

`source_type` / `source_id` are the hook every future module uses to link its own documents to the GL — AP-Flow posts with `source_type = 'ap_flow'` and `source_id` pointing at its own document row. `reverses_entry_id` links a reversing entry to its original.

Indexes: `idx_journal_entries_org_date` on `(org_id, entry_date)`, `idx_journal_entries_org_source` on `(org_id, source_type, source_id)`, and `ux_journal_entries_reverses` — a **partial unique** index on `reverses_entry_id WHERE reverses_entry_id IS NOT NULL`. Partial because the overwhelming majority of entries reverse nothing and the NULLs would otherwise all collide; unique because an entry may be reversed at most once, which is what makes the double-reversal check race-safe rather than a check-then-act.

Two deliberate departures from the rest of the schema:

- **No `updated_at`, and no `set_updated_at` trigger.** The row can never be updated, so an update timestamp would be a column that is guaranteed to equal `created_at` forever — dead scaffolding that implies a capability the table does not have.
- **`org_id` is `ON DELETE RESTRICT`, not `CASCADE`.** You cannot delete an organization that has posted journals. This is the correct accounting answer independently, and it is also the only way immutability and cascade can coexist: a `BEFORE DELETE` trigger that rejects every delete would abort the cascade anyway, and it is better to fail at the parent with a clear FK error than deep inside a trigger. Nothing in the application deletes organizations today.

**`ledger_lines`** — atomic debits/credits
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `journal_entry_id` UUID NOT NULL FK → `journal_entries` ON DELETE CASCADE · `account_id` UUID NOT NULL FK → `accounts` ON DELETE RESTRICT · `debit_cents` BIGINT NOT NULL DEFAULT 0 CHECK (`debit_cents >= 0`) · `credit_cents` BIGINT NOT NULL DEFAULT 0 CHECK (`credit_cents >= 0`) · `currency_code` CHAR(3) NOT NULL CHECK `~ '^[A-Z]{3}$'` · `fx_rate` NUMERIC(18,8) NOT NULL DEFAULT 1 CHECK (`fx_rate > 0`) · `base_debit_cents` BIGINT NOT NULL DEFAULT 0 CHECK (`base_debit_cents >= 0`) · `base_credit_cents` BIGINT NOT NULL DEFAULT 0 CHECK (`base_credit_cents >= 0`) · `created_at`

Constraints:
- `chk_line_nonzero` — NOT (`debit_cents = 0` AND `credit_cents = 0`)
- `chk_exclusive_debit_credit` — NOT (`debit_cents > 0` AND `credit_cents > 0`)
- `chk_base_nonzero` and `chk_exclusive_base_debit_credit` — the same pair on the base-currency columns
- `chk_side_agrees_with_base` — a line debited in its own currency is debited in base currency too: `(debit_cents > 0) = (base_debit_cents > 0)`

Index on `(org_id, account_id)` and `journal_entry_id`.

**The currency columns exist from Phase 3 even though the FX engine is Phase 8.** Phase 8 builds rate lookup, realized gain/loss on settlement, and period-end revaluation. The *columns* cannot wait for it: once a line has been written without its native amount and the rate used, that information is gone and no later migration can reconstruct it. For a single-currency organization every line is written with `currency_code` = the org's `base_currency`, `fx_rate` = 1, and the base columns equal to the native ones — so the trial balance and every statement in Phase 4 are already correct in base currency with no retrofit. **All reporting sums the `base_*` columns**; the native columns are for display and for Phase 8's settlement arithmetic.

### The balance invariant is enforced by the database

Rule 3 and rule 7 are application rules that `journalService` upholds. They are *also* upheld one layer down, so that a bug, a migration script, or a `psql` session cannot write an unbalanced entry:

```sql
-- fires once at COMMIT, not per statement, so a multi-line entry can be
-- inserted a line at a time without ever being transiently "unbalanced"
CREATE CONSTRAINT TRIGGER trg_ledger_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();
```

`assert_journal_entry_balanced()` resolves the entry as `COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)`, returns immediately if that entry no longer exists, and otherwise raises unless the entry's lines satisfy **`SUM(debit_cents) = SUM(credit_cents)`, `SUM(base_debit_cents) = SUM(base_credit_cents)`, and `COUNT(*) >= 2`**. Integer equality, never an epsilon — that is the whole reason the columns are `BIGINT` cents.

A second constraint trigger, `trg_journal_entries_have_lines`, fires `AFTER INSERT ON journal_entries`, also deferred, and runs the same assertion. Without it a header could be inserted with no lines at all: nothing would ever touch `ledger_lines`, so the first trigger would never fire, and a zero-line entry would satisfy "debits equal credits" vacuously.

**Immutability is enforced the same way.** `reject_mutation()` is a `BEFORE UPDATE OR DELETE` trigger on both `journal_entries` and `ledger_lines`, raising `ERRCODE = '0A000'` (`feature_not_supported`) with a message naming rule 6 and pointing at `POST /:id/reverse`. Corrections are reversing entries; there is no other path, and there is no route that could offer one.

`TRUNCATE` does **not** fire row-level triggers, so `resetTables()` in the test fixtures is unaffected and integration tests still get a clean database between cases.

---

## Phase 3.5 — Onboarding & Settings (LedgerCore) ✅ applied

**`005_ledger-core_settings.sql`.** Additive: one new constraint on `accounts`, one new table.

`accounts` gains `ux_accounts_org_id_id` — `UNIQUE (org_id, id)`. Logically redundant (`id` alone is already unique), but a composite `FOREIGN KEY` requires its target column set to be declared unique as that exact tuple, so this is the price of letting `ledger_settings.cash_account_id` reference `accounts` scoped by tenant rather than by id alone. See [study/postgresql/composite-foreign-keys-for-tenancy.md](../study/postgresql/composite-foreign-keys-for-tenancy.md).

**`ledger_settings`** — one row per organization, LedgerCore's onboarding and settings
`org_id` UUID **PRIMARY KEY** FK → `organizations` ON DELETE CASCADE · `legal_name` TEXT (nullable) · `fiscal_year_start_month` SMALLINT NOT NULL CHECK BETWEEN 1 AND 12 · `fiscal_year_start_day` SMALLINT NOT NULL DEFAULT 1 CHECK BETWEEN 1 AND 28 · `books_start_date` DATE NOT NULL · `industry` TEXT (nullable) · `timezone` TEXT NOT NULL DEFAULT `'UTC'` · `cash_account_id` UUID (nullable) · `onboarded_at` TIMESTAMPTZ NOT NULL DEFAULT now() · `created_at` · `updated_at`

`org_id` is the primary key, not a separate `id` — there is exactly one settings row per organization, and keying on the scope column indexes it for free.

Constraint:
- `fk_ledger_settings_cash_account` — **composite** `FOREIGN KEY (org_id, cash_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT`. Makes a cross-tenant `cash_account_id` physically unrepresentable, not merely service-checked. `MATCH SIMPLE` (the default): a `NULL cash_account_id` — no cash account configured yet — satisfies the constraint without being checked, which is exactly the wanted behavior. `RESTRICT`, not `SET NULL`: a composite FK's `SET NULL` nulls *every* column in the key, including `org_id`, which is this table's `NOT NULL` primary key — `RESTRICT` never actually fires in practice, since `accounts` rows are never deleted (retired via `is_active = false` instead).

Index on `cash_account_id`.

**Deliberately no seed row and no backfill migration.** The absence of a `ledger_settings` row *is* the "onboarding not yet completed" signal — correct for every organization that predates this migration, which is why `onboarded_at` is `NOT NULL`: the row only ever exists once onboarding actually completed. `GET /settings` returns `200` with `onboardedAt: null` and sensible defaults for a missing row, never a `404`.

**`organizationName` and `baseCurrency` are not columns on this table.** Both remain on `organizations` (Phase 1) and are edited through `PATCH /organizations`, a platform route — see [architecture.md](architecture.md#product-structure)'s platform/app split. `ledger_settings` only owns fields LedgerCore itself is responsible for.

**Not built in this phase:** `fiscal_periods`, period close/lock, and any trigger rejecting a posting into a closed period — all Phase 4, unchanged by this migration. `fiscal_year_start_month`/`_day` here are a *setting* consumed by report queries in application code; no period rows exist anywhere in the schema yet.

---

## Phase 3.8 — Navigation fixes & sales invoicing (LedgerCore) ✅ applied

**`006_platform_organization_tax_ids.sql`** — `organizations` gains `tax_number`/`business_number` (see Phase 1 above). **`007_ledger-core_invoice_settings.sql`**, **`008_ledger-core_customers.sql`**, **`009_ledger-core_invoices.sql`**, **`010_ledger-core_invoice_lines_org_index.sql`** — three new tables plus a follow-up index. A fourth half-step in the 3.5/3.6/3.7 lineage; renumbers nothing, and Phase 4 (live statements, fiscal periods, the AR/AP subledger *report*) remains unstarted.

**`ledger_invoice_settings`** — one row per organization, invoice numbering/defaults/branding
`org_id` UUID **PRIMARY KEY** FK → `organizations` ON DELETE CASCADE · `number_prefix` TEXT NOT NULL DEFAULT `'INV-'` · `number_padding` SMALLINT NOT NULL DEFAULT 6 CHECK BETWEEN 1 AND 12 · `next_number` INTEGER NOT NULL DEFAULT 1 CHECK `> 0` · `default_due_days` SMALLINT NOT NULL DEFAULT 30 · `default_tax_rate_bp` INTEGER NOT NULL DEFAULT 0 CHECK BETWEEN 0 AND 10000 · `tax_label` TEXT NOT NULL DEFAULT `'Tax'` · `receivable_account_id` / `default_revenue_account_id` / `tax_payable_account_id` UUID (nullable) · `show_tax_number` / `show_business_number` / `show_legal_name` BOOLEAN · `billing_address` / `payment_terms` / `footer_notes` TEXT (nullable) · `accent_color` TEXT NOT NULL DEFAULT `'#2563eb'` CHECK `~ '^#[0-9a-fA-F]{6}$'` · `created_at` · `updated_at`

Same "no seed row, no backfill" posture as `ledger_settings`: absence means "never configured," and `getInvoiceSettings` returns these same defaults with `configured: false` for a missing row. The three account-id columns each carry a **composite** FK to `accounts (org_id, id)` — `fk_invoice_settings_receivable_account`, `_revenue_account`, `_tax_account` — `ON DELETE RESTRICT`, the same reasoning as `ledger_settings.cash_account_id`.

**`customers`** — the parties invoices are issued to, per organization
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `name` TEXT NOT NULL CHECK non-blank · `email` / `phone` / `billing_address` / `tax_number` / `notes` (nullable) · `is_active` BOOLEAN NOT NULL DEFAULT true · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` · `updated_at`
Constraint: `ux_customers_org_id_id` — `UNIQUE (org_id, id)`, so `invoices` can carry a composite FK into it. No `DELETE` route — retired via `is_active = false`, matching `accounts`.

**`invoices`** — sales (accounts-receivable) documents
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` **ON DELETE RESTRICT** (matches `journal_entries`: an org with issued invoices can't be deleted) · `customer_id` UUID NOT NULL · `invoice_number` TEXT (nullable while `DRAFT`) · `status` TEXT NOT NULL DEFAULT `'DRAFT'` CHECK IN (`DRAFT`,`ISSUED`,`VOID`) · `issue_date` / `due_date` DATE NOT NULL · `currency_code` CHAR(3) NOT NULL (always the org's base currency) · `customer_name_snapshot` TEXT NOT NULL, `customer_address_snapshot` / `customer_tax_number_snapshot` TEXT (nullable — frozen at write time so a later customer edit never rewrites a posted document) · `notes` / `payment_terms` TEXT (nullable) · `subtotal_cents` / `tax_cents` / `total_cents` BIGINT NOT NULL DEFAULT 0 · `journal_entry_id` / `void_journal_entry_id` UUID (nullable) · `issued_at` / `voided_at` TIMESTAMPTZ (nullable) · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` · `updated_at`

Constraints: `ux_invoices_org_id_id` — `UNIQUE (org_id, id)` · `ux_invoices_org_number` — `UNIQUE (org_id, invoice_number)`, tolerating unlimited `NULL`s (every draft is numberless) · `chk_invoices_total` — `total_cents = subtotal_cents + tax_cents` · `chk_invoices_due_not_before_issue` · `chk_invoices_issued_complete` — an `ISSUED` row must carry a number, a `journal_entry_id`, and `issued_at`. Composite FKs `fk_invoices_customer` → `customers (org_id, id)`, `fk_invoices_journal_entry` / `fk_invoices_void_journal_entry` → `journal_entries (org_id, id)` (needing `journal_entries` to gain its own `ux_journal_entries_org_id_id`, added by this migration), all `ON DELETE RESTRICT`.

**`invoice_lines`**
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `invoice_id` UUID NOT NULL · `line_number` SMALLINT NOT NULL CHECK `> 0` · `description` TEXT NOT NULL CHECK non-blank · `quantity_milli` BIGINT NOT NULL CHECK `> 0` (thousandths of a unit — `2500` means `2.5`, never a float) · `unit_price_cents` BIGINT NOT NULL · `revenue_account_id` UUID NOT NULL · `tax_rate_bp` INTEGER NOT NULL DEFAULT 0 CHECK BETWEEN 0 AND 10000 (basis points, never a float) · `net_cents` / `tax_cents` BIGINT NOT NULL · `created_at`
Constraint `ux_invoice_lines_invoice_line` — `UNIQUE (invoice_id, line_number)`. `fk_invoice_lines_invoice` → `invoices (org_id, id)` **ON DELETE CASCADE** (a draft's lines go with it); `fk_invoice_lines_revenue_account` → `accounts (org_id, id)` ON DELETE RESTRICT. Index `idx_invoice_lines_org_invoice` on `(org_id, invoice_id)`, added by the follow-up migration `010` — mirrors `ledger_lines`' `idx_ledger_lines_org_account` scope index, a guardrail-review finding from this phase's own review pass.

### Two immutability triggers, one absolute and one with a carve-out

**`reject_issued_invoice_mutation()`** (on `invoices`, `BEFORE UPDATE OR DELETE`) — a `DRAFT` row may be freely edited or deleted (it has posted nothing); once `ISSUED`, only the `ISSUED -> VOID` transition is permitted, and even that transition may change only `status`, `voided_at`, `void_journal_entry_id` — checked with a `to_jsonb(NEW) - '<col>' IS DISTINCT FROM to_jsonb(OLD) - '<col>'` row-diff rather than an enumerated column list, so a future column addition is automatically frozen once issued. Raises `0A000`. See [study/postgresql/deferred-constraint-triggers.md § Partial immutability](../study/postgresql/deferred-constraint-triggers.md#partial-immutability--phase-38s-issued---void-carve-out).

**`reject_non_draft_invoice_line_mutation()`** (on `invoice_lines`, `BEFORE INSERT OR UPDATE OR DELETE`) — absolute, no carve-out: any line mutation is rejected the instant its parent invoice leaves `DRAFT`. A `NULL` parent status (the parent row is mid-`CASCADE`-delete of a `DRAFT` invoice, already authorised) passes through rather than raising.

### The FSM and the CHECK must agree

`server/src/types/accounting.ts`'s `INVOICE_TRANSITIONS` (`DRAFT -> [ISSUED, VOID]`, `ISSUED -> [VOID]`, `VOID -> []`) is the one place a status transition is decided in code; the `status` CHECK above lists the identical three values. See [study/architecture/document-lifecycle-fsm.md](../study/architecture/document-lifecycle-fsm.md).

**Not built in this phase:** a `PAID` status or any payment/cash-receipt document — an issued invoice's receivable never clears except by voiding. No AR aging, no AR subledger report, no PDF generation, no multi-currency invoices (the FX engine is Phase 8), no fiscal-period lock on the invoice date. **Payment recording and AR/AP aging landed in Phase 3.9, immediately below.**

---

## Phase 3.9 — Accounts payable & payments (LedgerCore) ✅ applied

**`011_ledger-core_vendors.sql`**, **`012_ledger-core_ap_posting_accounts.sql`**, **`013_ledger-core_bills.sql`**, **`014_ledger-core_payments.sql`** — four migrations: one new table (`vendors`), three new columns on `ledger_settings`, two new tables (`bills`, `bill_lines`), and two more (`payments`, `payment_allocations`). A fifth half-step in the 3.5/3.6/3.7/3.8 lineage — renumbers nothing. This phase pays off the "AR/AP subledgers" line item the roadmap table assigned to Phase 4; **Phase 4's remaining scope is P&L, balance sheet, and fiscal periods with close/lock — nothing else.**

**`vendors`** — the parties bills are entered against, per organization
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `name` TEXT NOT NULL CHECK non-blank · `email` / `phone` / `billing_address` / `tax_number` / `payment_terms` / `notes` (nullable) · `is_active` BOOLEAN NOT NULL DEFAULT true · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` · `updated_at`
Constraint: `ux_vendors_org_id_id` — `UNIQUE (org_id, id)`, so `bills` can carry a composite FK into it. No `DELETE` route — retired via `is_active = false`, matching `customers`.

**`ledger_settings`** gains three nullable columns for AP posting: `payable_account_id`, `tax_input_account_id`, `default_expense_account_id` — each a **composite** FK to `accounts (org_id, id)` `ON DELETE RESTRICT`, same reasoning as `cash_account_id` and `ledger_invoice_settings`' three account columns. All nullable; an existing organization needs no backfill, and bill approval falls back to the default chart's `2100`/`1180` when unset.

**`bills`** — purchase (accounts-payable) documents
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` **ON DELETE RESTRICT** · `vendor_id` UUID NOT NULL · `vendor_reference` TEXT NOT NULL CHECK non-blank (the **vendor's own** invoice number — the duplicate-payment control) · `status` TEXT NOT NULL DEFAULT `'DRAFT'` CHECK IN (`DRAFT`,`AWAITING_APPROVAL`,`POSTED`,`VOID`) · `bill_date` / `due_date` DATE NOT NULL · `currency_code` CHAR(3) NOT NULL · `vendor_name_snapshot` TEXT NOT NULL, `vendor_address_snapshot` / `vendor_tax_number_snapshot` TEXT (nullable, frozen at write time) · `notes` / `payment_terms` TEXT (nullable) · `subtotal_cents` / `tax_cents` / `total_cents` BIGINT NOT NULL DEFAULT 0 · `journal_entry_id` / `void_journal_entry_id` UUID (nullable) · `submitted_at` / `posted_at` / `voided_at` TIMESTAMPTZ (nullable) · `approved_by` FK → `users` ON DELETE RESTRICT (nullable) · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` · `updated_at`

Constraints: `ux_bills_org_id_id` — `UNIQUE (org_id, id)` · `ux_bills_vendor_reference` — `UNIQUE (org_id, vendor_id, vendor_reference)` · `chk_bills_total` · `chk_bills_due_not_before_bill_date` · `chk_bills_posted_complete` — a `POSTED` row must carry a `journal_entry_id`, `posted_at`, and `approved_by`. Composite FKs `fk_bills_vendor` → `vendors (org_id, id)`, `fk_bills_journal_entry` / `fk_bills_void_journal_entry` → `journal_entries (org_id, id)`, all `ON DELETE RESTRICT`.

**`bill_lines`**
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `bill_id` UUID NOT NULL · `line_number` SMALLINT NOT NULL CHECK `> 0` · `description` TEXT NOT NULL CHECK non-blank · `quantity_milli` BIGINT NOT NULL CHECK `> 0` · `unit_price_cents` BIGINT NOT NULL · `expense_account_id` UUID NOT NULL (an `Expense` **or** `Asset` account — a bill may buy a fixed asset or a prepaid, unlike an invoice's revenue-only line) · `tax_rate_bp` INTEGER NOT NULL DEFAULT 0 CHECK BETWEEN 0 AND 10000 · `net_cents` / `tax_cents` BIGINT NOT NULL · `created_at`
Constraint `ux_bill_lines_bill_line` — `UNIQUE (bill_id, line_number)`. `fk_bill_lines_bill` → `bills (org_id, id)` **ON DELETE CASCADE**; `fk_bill_lines_expense_account` → `accounts (org_id, id)` ON DELETE RESTRICT. Index `idx_bill_lines_org_bill` on `(org_id, bill_id)`.

### A four-state FSM, not three — and two immutability triggers to match

Unlike an invoice, a bill has **four** lifecycle states: `DRAFT -> AWAITING_APPROVAL -> POSTED -> VOID`, plus a recall edge `AWAITING_APPROVAL -> DRAFT`. Entry and approval are deliberately separate acts of trust — `POST /bills/:id/submit` needs `ACCOUNTANT` or above, `POST /bills/:id/approve` needs `OWNER`/`ADMIN` only. See [study/architecture/document-lifecycle-fsm.md § The four-state extension](../study/architecture/document-lifecycle-fsm.md).

**`reject_posted_bill_mutation()`** (on `bills`, `BEFORE UPDATE OR DELETE`) — `DRAFT` and `AWAITING_APPROVAL` rows are freely editable; once `POSTED`, only `POSTED -> VOID` is permitted, and only touching `status`/`voided_at`/`void_journal_entry_id`, via the same `to_jsonb` row-diff technique migration `009` established. Raises `0A000`.

**`reject_locked_bill_line_mutation()`** (on `bill_lines`) — a line may be inserted/changed/removed while its parent is `DRAFT` **or** `AWAITING_APPROVAL`; locked the instant the parent reaches `POSTED`. `NULL` parent status (mid-`CASCADE`) passes through.

**`payments`** — settlement of invoices (RECEIVE) and bills (PAY), born posted
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `direction` TEXT NOT NULL CHECK IN (`RECEIVE`,`PAY`) · `status` TEXT NOT NULL DEFAULT `'POSTED'` CHECK IN (`POSTED`,`VOID`) · `payment_date` DATE NOT NULL · `currency_code` CHAR(3) NOT NULL · `amount_cents` BIGINT NOT NULL CHECK `> 0` · `cash_account_id` UUID NOT NULL · `customer_id` / `vendor_id` UUID (nullable, exactly one set per direction) · `method` / `reference` / `notes` TEXT (nullable) · `journal_entry_id` UUID **NOT NULL** (a payment cannot exist without its posting — there is no draft) · `void_journal_entry_id` UUID (nullable) · `voided_at` TIMESTAMPTZ (nullable) · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` · `updated_at`

Constraints: `ux_payments_org_id_id` · `chk_payments_counterparty` — `RECEIVE` requires `customer_id` set and `vendor_id` null, `PAY` the reverse. Composite FKs `fk_payments_cash_account` → `accounts`, `fk_payments_customer` → `customers`, `fk_payments_vendor` → `vendors`, `fk_payments_journal_entry` / `fk_payments_void_journal_entry` → `journal_entries`, all `ON DELETE RESTRICT`.

**`payment_allocations`** — which documents a payment settles, and by how much; **insert-only, forever**
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `payment_id` UUID NOT NULL · `invoice_id` / `bill_id` UUID (nullable, exactly one set) · `amount_cents` BIGINT NOT NULL CHECK `> 0` · `created_at`

Constraints: `chk_allocation_one_target` · `ux_allocation_payment_invoice` / `ux_allocation_payment_bill` — `UNIQUE (payment_id, invoice_id)` / `UNIQUE (payment_id, bill_id)`, tolerating unlimited `NULL`s. Composite FKs to `payments`, `invoices`, `bills`, all `ON DELETE RESTRICT`.

### Two deferred constraint triggers, plus absolute immutability

**`assert_payment_allocations_complete()`** — `AFTER INSERT OR UPDATE ON payments`, `DEFERRABLE INITIALLY DEFERRED`: a `POSTED` payment must have at least one allocation, summing to exactly its `amount_cents`. Deferred because the payment row is always inserted before its allocations can exist. Skips a `VOID` payment.

**`assert_no_overallocation()`** — `AFTER INSERT ON payment_allocations`, `DEFERRABLE INITIALLY DEFERRED`: allocations against one document, summed across every `POSTED` payment that has ever targeted it (not just the current transaction's), must never exceed that document's total. See [study/postgresql/deferred-constraint-triggers.md § A deferred-trigger pair](../study/postgresql/deferred-constraint-triggers.md).

**`reject_payment_mutation()`** — absolute except `POSTED -> VOID`, same row-diff technique as bills/invoices. **`reject_allocation_mutation()`** — absolute, no carve-out at all: `payment_allocations` rows are never updated or deleted, ever. This is what lets voiding a payment un-settle its documents with zero additional writes — see [study/architecture/derived-vs-stored-state.md](../study/architecture/derived-vs-stored-state.md).

### Settlement is derived, never stored

Neither `invoices` nor `bills` gained a `PAID` status or an `amount_paid_cents` column. `allocatedCents`/`amountDueCents`/`settlementStatus` are computed on every read from `payment_allocations`, filtered to `POSTED` payments — the same no-summary-table discipline `reportService`/`dashboardService` already follow. See [study/architecture/derived-vs-stored-state.md](../study/architecture/derived-vs-stored-state.md).

**Not built in this phase:** an expense-claim/employee-reimbursement document, credit notes, vendor credits, partial void, PDF export, multi-currency payments, fiscal-period posting locks, audit trail. None of these are silently implied by anything above. (Credit notes and vendor credits — debit notes — landed in [Phase 26](#phase-26--credit--debit-notes-ledgercore--applied); settlement then became payments **plus** applied notes.)

---

## Phase 4 — live statements & fiscal periods (LedgerCore) — applied

Two migrations. `015` adds the schema; `016` adds the enforcement.

**`015_ledger-core_fiscal_periods.sql`** — `CREATE EXTENSION IF NOT EXISTS btree_gist` (the project's first extension), then `fiscal_periods`:
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `fiscal_year_label` TEXT NOT NULL CHECK non-blank · `period_number` SMALLINT NOT NULL CHECK BETWEEN 1 AND 12 · `starts_on` / `ends_on` DATE NOT NULL · `status` TEXT NOT NULL DEFAULT `'OPEN'` CHECK IN (`OPEN`,`CLOSED`,`LOCKED`) — **uppercase**, matching every other status enum in this schema, not the lowercase forecast this section used to carry · `closed_by` / `locked_by` FK → `users` ON DELETE RESTRICT (nullable) · `closed_at` / `locked_at` TIMESTAMPTZ (nullable) · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` · `updated_at`.

Constraints: `ux_fiscal_periods_org_id_id` — `UNIQUE (org_id, id)`, the same composite-FK-target convention every LedgerCore table follows · `chk_fiscal_periods_range` — `ends_on >= starts_on` · `chk_fiscal_periods_closed_complete` / `chk_fiscal_periods_locked_complete` — the same "posted-complete" CHECK idiom as `chk_bills_posted_complete`, requiring the stamp columns whenever the status claims them · **`ex_fiscal_periods_no_overlap`** — `EXCLUDE USING GIST (org_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)`, making two overlapping periods in one organization physically impossible to insert, independent of what wrote the row. See [study/postgresql/exclusion-constraints-and-gist.md](../study/postgresql/exclusion-constraints-and-gist.md).

**`016_ledger-core_period_posting_guard.sql`** — `assert_period_open()`, a plain `BEFORE INSERT` trigger (not deferred — this depends on one row and one lookup) on both `journal_entries` and `ledger_lines`. A date covered by no period is open; a date covered by a `CLOSED` or `LOCKED` period raises `P0001`. This is the database half of the guard `journalService.createEntryOnClient`/`reverseEntryOnClient` also check in the service, the same two-layer doctrine as migration 004's balance trigger.

**The FSM.** `FISCAL_PERIOD_TRANSITIONS`: `OPEN -> CLOSED`, `CLOSED -> OPEN | LOCKED`, `LOCKED -> ` (nothing). `LOCKED` is the first genuinely terminal state in the codebase's FSMs — see [study/architecture/document-lifecycle-fsm.md § A genuinely terminal state](../study/architecture/document-lifecycle-fsm.md).

**`GET /reports/profit-and-loss`** and **`GET /reports/balance-sheet`** — both computed from `ledger_lines` on every request, no summary table, same discipline as `trialBalance`. The balance sheet's `retainedEarningsCents`/`currentEarningsCents` are **derived**, not read from account `3200` — LedgerCore posts no year-end closing entry. See [study/postgresql/aggregating-a-ledger.md § Deriving a P&L and a balance sheet from raw lines](../study/postgresql/aggregating-a-ledger.md).

**Not built in this phase:** no year-end closing journal entry (retained earnings stays derived, forever, unless one is added later); a manually-posted closing entry into `3200` double-counts that year's earnings, a stated and accepted gap; quarterly or 4-4-5 fiscal calendars (`period_number` is capped at 12 monthly periods); a per-period P&L drilldown; audit trail.

---

## Phase 5 — shared CDC audit trail — applied

Two migrations, platform-level (no app-slug tag in the filename). `017` adds the table; `018` attaches capture to every audited table.

**`017_platform_audit_logs.sql`** — `audit_logs`:
`id` `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` — a plain sequence, not a UUID like every other table; a log's defining property is arrival order, which a UUID carries none of · `txid` `BIGINT NOT NULL DEFAULT (pg_current_xact_id()::text::bigint)` — groups every row one transaction wrote, since `created_at` alone can't (it's transaction-start time, shared by every row in the same transaction) · `org_id` UUID, **no `REFERENCES`** · `app_slug` TEXT NOT NULL CHECK non-blank · `table_name` TEXT NOT NULL · `row_id` UUID, **no `REFERENCES`** · `operation` TEXT NOT NULL CHECK IN (`INSERT`,`UPDATE`,`DELETE`) · `old_row` / `new_row` JSONB · `changed_keys` TEXT[] (UPDATE only) · `actor_user_id` UUID, **no `REFERENCES`** · `client_ip` TEXT CHECK length <= 45 · `created_at` TIMESTAMPTZ NOT NULL DEFAULT `now()`.

`org_id`, `row_id`, and `actor_user_id` are the one deliberate exception to "every `*_id` gets a `REFERENCES`" (guardrails rule 8) anywhere in this schema: an audit row has to outlive the organization, row, and user it describes, and `row_id` is polymorphic across sixteen tables with no single valid FK target regardless. The reasoning is written directly into the migration's header comment, not left implicit.

Constraint: `chk_audit_logs_payload` — INSERT has `old_row IS NULL`/`new_row IS NOT NULL`, UPDATE has both, DELETE has `old_row IS NOT NULL`/`new_row IS NULL`. Indexes: `(org_id, created_at DESC, id DESC)`, `(org_id, table_name, row_id)`, `(org_id, actor_user_id)`, `(org_id, app_slug)`, `(txid)`.

`audit_row_change()` — the generic capture trigger function, `to_jsonb(NEW)`/`to_jsonb(OLD)` for the row snapshot, a `jsonb_each` + `IS DISTINCT FROM` diff for `changed_keys`, and the actor/IP read via `current_setting('app.current_user_id'/'app.client_ip', true)` — published by `db/transaction.ts`'s `applyAuditContext()` with `set_config(..., is_local := true)` right after every `BEGIN`. See [study/postgresql/audit-triggers-and-session-variables.md](../study/postgresql/audit-triggers-and-session-variables.md).

`reject_audit_log_mutation()` — the same `0A000` immutability treatment as `journal_entries` (migration 004), attached `BEFORE UPDATE OR DELETE` on `audit_logs` itself.

**`018_platform_audit_triggers.sql`** — attaches `audit_row_change()` as an `AFTER INSERT OR UPDATE OR DELETE` trigger to 16 tables: `organizations`, `organization_members` (slug `platform`); `accounts`, `journal_entries`, `ledger_lines`, `ledger_settings`, `ledger_invoice_settings`, `customers`, `vendors`, `invoices`, `invoice_lines`, `bills`, `bill_lines`, `payments`, `payment_allocations`, `fiscal_periods` (slug `ledger-core`). Deliberately **not** audited: `users`/`refresh_tokens` (would copy a password hash or session credential into a table nobody may delete rows from) and `schema_migrations` (the runner's own bookkeeping).

**`npm run verify:integrity`** (`server/src/db/integrity.ts` + `server/src/scripts/verifyIntegrity.ts`) — a standalone script, not a migration or a route, asserting three invariants across the whole database: total debits equal total credits, every entry balances individually, no ledger line is orphaned or claims the wrong `org_id`. Its three queries are the one place in the codebase deliberately exempted from the "every query is `org_id`-scoped" rule, documented as such and structurally isolated in `src/db/` so no request-serving code can import it. See [study/postgresql/integrity-checking-a-ledger.md](../study/postgresql/integrity-checking-a-ledger.md).

**Not built in this phase:** retention or partitioning on `audit_logs` — it grows without bound (a write amplification cost stated explicitly: registering an organization writes ~46 audit rows via the default-chart seed, a 20-line journal entry writes 21). No hash-chaining or other tamper-evidence beyond the immutability trigger, which a table-owner-privileged actor can still bypass by disabling it first — the trail is a strong guarantee against application-level tampering, not an absolute one. ~~No continuous/scheduled integrity check — `verify:integrity` is run on demand until Phase 7's background jobs land.~~ **Resolved in [Phase 7](#phase-7--background-jobs--webhooks--applied):** `verify:integrity`'s three checks now also run on a daily schedule via the background worker.

---

## Phase 6 — bank reconciliation (LedgerCore) — applied

One migration. `019_ledger-core_bank_reconciliation.sql` adds three tables and attaches audit capture to two of them.

**`bank_statement_imports`** — one row per uploaded CSV:
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `account_id` UUID NOT NULL, composite FK → `accounts (org_id, id)` ON DELETE RESTRICT · `file_name` TEXT NOT NULL CHECK non-blank, <= 200 · `date_format` TEXT NOT NULL CHECK IN (`ISO`,`DMY`,`MDY`) · `delimiter` TEXT NOT NULL CHECK length = 1 · `row_count` / `imported_count` / `duplicate_count` INTEGER NOT NULL DEFAULT 0, each CHECK >= 0, plus `chk_bank_imports_counts` — `imported_count + duplicate_count <= row_count` · `earliest_date` / `latest_date` DATE (nullable) · `closing_balance_cents` BIGINT (nullable, signed) / `closing_balance_on` DATE (nullable) — `chk_bank_imports_closing_pair` requires both or neither · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` / `updated_at`.

**`bank_transactions`** — one row per parsed statement line:
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `import_id` UUID NOT NULL, composite FK → `bank_statement_imports (org_id, id)` ON DELETE RESTRICT · `account_id` UUID NOT NULL, composite FK → `accounts (org_id, id)` ON DELETE RESTRICT · `txn_date` DATE NOT NULL · `description` TEXT NOT NULL CHECK <= 500 · `external_reference` TEXT (nullable, <= 100) · `currency_code` CHAR(3) NOT NULL · `amount_cents` BIGINT NOT NULL CHECK <> 0 — **signed**: positive is money in, negative is money out, unlike a `ledger_lines` row which always has exactly one side populated · `dedupe_hash` CHAR(64) NOT NULL · `status` TEXT NOT NULL DEFAULT `'UNMATCHED'` CHECK IN (`UNMATCHED`,`MATCHED`,`IGNORED`) · `matched_payment_id` UUID (nullable), composite FK → `payments (org_id, id)` ON DELETE RESTRICT · `matched_journal_entry_id` UUID (nullable, migration 057, Phase 6.1), composite FK → `journal_entries (org_id, id)` ON DELETE RESTRICT — set instead of `matched_payment_id` when the line was settled by a directly-posted journal entry rather than a match against an invoice/bill · `matched_at` TIMESTAMPTZ (nullable) · `matched_by` FK → `users` ON DELETE RESTRICT (nullable) · `created_at` / `updated_at`.

Constraints: `ux_bank_transactions_org_id_id` — `UNIQUE (org_id, id)`, the standard composite-FK-target convention · **`ux_bank_transactions_dedupe`** — `UNIQUE (org_id, dedupe_hash)`, what makes re-importing the same statement idempotent (the hash folds in an occurrence ordinal so two genuinely identical lines in one file both survive — see [study/postgresql/idempotent-ingestion-and-dedupe-hashes.md](../study/postgresql/idempotent-ingestion-and-dedupe-hashes.md)) · `chk_bank_txn_matched_fields` (migration 057, Phase 6.1; replaces its Phase 6 form) — `matched_at`/`matched_by` are set when `status = 'MATCHED'` and all three match fields `NULL` otherwise; when `MATCHED`, **exactly one** of `matched_payment_id`/`matched_journal_entry_id` is set — `(matched_payment_id IS NULL) <> (matched_journal_entry_id IS NULL)`, an XOR — never both and never neither, since a line now settles either by matching a document (a payment) or by a direct journal posting.

**`bank_match_suggestions`** — up to 5 scored candidates per unmatched line, deleted and regenerated wholesale on every rescore:
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE **CASCADE** (the one FK in this table pair that cascades, since a suggestion is disposable derived data, not a record of fact) · `bank_transaction_id` UUID NOT NULL, composite FK → `bank_transactions (org_id, id)` ON DELETE CASCADE · `target_type` TEXT NOT NULL CHECK IN (`invoice`,`bill`) · `invoice_id` / `bill_id` UUID (nullable), composite FKs → `invoices`/`bills (org_id, id)` ON DELETE RESTRICT, `chk_bank_suggestion_one_target` requiring exactly one set, matching `target_type` · `score` INTEGER NOT NULL CHECK BETWEEN 0 AND 100 · `score_breakdown` JSONB NOT NULL — `{ amount, date, counterparty }`, each `{ points, maxPoints, reason }`, so a score is explainable rather than a magic number · `created_at`.

**Immutability.** `bank_transactions` gets the same `to_jsonb` row-diff carve-out treatment as `payments` (migration 014): `reject_bank_transaction_mutation()` permits changing only `status`/`matched_payment_id`/`matched_journal_entry_id`/`matched_at`/`matched_by` (the carve-out list extended by migration 057 for the new column), raises `0A000` on any other column change or on `DELETE` — a bank line is a record of fact from a downloaded statement, never edited or removed. `bank_statement_imports` and `bank_match_suggestions` carry no immutability trigger; an import's counts are updated once, in the same transaction that inserts its lines, and suggestions are deliberately disposable.

**The FSM.** `BANK_TRANSACTION_TRANSITIONS`: `UNMATCHED -> MATCHED | IGNORED`, `MATCHED -> UNMATCHED`, `IGNORED -> UNMATCHED`. The first FSM in this schema where a non-terminal reverse edge (`MATCHED -> UNMATCHED`) carries a GL side effect — voiding the payment the match posted — rather than touching only its own row. See [study/architecture/document-lifecycle-fsm.md § A reversible state whose reverse edge carries a GL side effect](../study/architecture/document-lifecycle-fsm.md).

**Audit.** `bank_statement_imports` and `bank_transactions` both get `audit_row_change('ledger-core')`. **`bank_match_suggestions` is deliberately not audited** — the same reasoning migration 018 gives for `schema_migrations`: it is derived data, deleted and regenerated wholesale on every rescore, so auditing it would write up to five rows per rescore with no compliance value.

**`GET /reports/bank-reconciliation`** — compares the named account's posted GL balance against the sum of every imported, non-`IGNORED` line for the same account, both computed independently and compared by integer equality. Unlike `/ar-aging`/`/ap-aging`'s `reconciles`, a `false` here is a **completeness** claim about the imported statement history, not a **correctness** claim about the books. See [study/postgresql/subledger-reconciliation-and-aging.md § Bank reconciliation](../study/postgresql/subledger-reconciliation-and-aging.md).

**Not built in this phase:** a bank line settling more than one document (or several lines settling one document) in a single match — matching is always one line to at most one document; bank feeds/OFX/QIF/MT940 (CSV only); multi-currency statements; posting a journal entry directly from an unmatched line for fees/interest (`IGNORE` covers that case for now).

---

## Phase 7 — background jobs & webhooks — applied

Two migrations. `020_platform_outbox_and_webhooks.sql` adds the transactional outbox and the webhook subsystem, platform-level (no app-slug tag). `021_ledger-core_unmatched_alert_threshold.sql` adds the one LedgerCore column that configures it.

**`outbox_events`** — one row per financial event, written on the same transaction client as the fact it describes (guardrails rule 5):
`id` `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` — arrival order matters, same reasoning as `audit_logs`, not a UUID · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `app_slug` TEXT NOT NULL CHECK non-blank, <= 40 · `event_type` TEXT NOT NULL CHECK non-blank, <= 60 · `payload` JSONB NOT NULL · `created_at` TIMESTAMPTZ NOT NULL DEFAULT `now()` · `published_at` TIMESTAMPTZ (nullable — `NULL` means "not yet drained"). A **partial** index, `(id) WHERE published_at IS NULL`, is the drain query's only index: the interesting set is always the unpublished tail, and a full index would grow forever tracking rows the query never looks at again.

**`webhook_endpoints`** — a tenant's registered receivers:
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `url` TEXT NOT NULL CHECK non-blank, <= 500 · `label` TEXT NOT NULL CHECK non-blank, <= 100 · `secret` TEXT NOT NULL CHECK length = 64 — **stored in plaintext**, unlike a password, because the server must reproduce the exact HMAC key on every send; the mitigation is that no `SELECT` in `webhookService.ts` ever includes this column · `event_types` TEXT[] NOT NULL CHECK `cardinality` BETWEEN 1 AND 20 · `is_active` BOOLEAN NOT NULL DEFAULT TRUE · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` / `updated_at`. `ux_webhook_endpoints_org_id_id` — `UNIQUE (org_id, id)`, the composite-FK-target convention · `ux_webhook_endpoints_org_url` — `UNIQUE (org_id, url)`.

**`webhook_deliveries`** — one row per (event, subscribed endpoint) pair, tracking every attempt:
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `endpoint_id` UUID NOT NULL, composite FK → `webhook_endpoints (org_id, id)` ON DELETE CASCADE · `event_id` BIGINT NOT NULL FK → `outbox_events` ON DELETE CASCADE · `event_type` TEXT NOT NULL CHECK <= 60 · `payload` JSONB NOT NULL (copied from the event at fan-out time, so a delivery survives the source event being pruned in the future) · `status` TEXT NOT NULL DEFAULT `'PENDING'` CHECK IN (`PENDING`,`DELIVERED`,`FAILED`) · `attempt_count` INTEGER NOT NULL DEFAULT 0 CHECK >= 0 · `last_status_code` INTEGER (nullable) CHECK BETWEEN 100 AND 599 · `last_error` TEXT (nullable) CHECK <= 500 · `delivered_at` TIMESTAMPTZ (nullable) · `created_at` / `updated_at`. `ux_webhook_deliveries_org_id_id` — the standard convention · **`ux_webhook_deliveries_event_endpoint`** — `UNIQUE (event_id, endpoint_id)`, what makes the drain's fan-out idempotent (`ON CONFLICT DO NOTHING`, a retried or overlapping drain pass creates nothing new) · `chk_webhook_delivery_delivered` — the "posted-complete" idiom: `delivered_at`/`last_status_code` set only when `status = 'DELIVERED'`. A partial index `(updated_at) WHERE status = 'PENDING'` serves the stale-delivery re-enqueue sweep.

**The FSM.** `WEBHOOK_DELIVERY_TRANSITIONS`: `PENDING -> DELIVERED | FAILED`, `DELIVERED -> ` (terminal — a received webhook cannot be un-received), `FAILED -> PENDING` (the one reverse edge, an operator's manual retry). `markDelivered`/`markFailed` both carry `WHERE status = 'PENDING'` in their `UPDATE`, enforcing the FSM in SQL as well as in the service, so a duplicate completion signal (two job attempts racing) cannot resurrect a row.

**Audit.** `webhook_endpoints` gets `audit_row_change('platform')` — an endpoint is a configuration surface: adding a URL is how a tenant's financial events start leaving the building, which is a compliance-relevant action. **`outbox_events` and `webhook_deliveries` are deliberately not audited** — the same reasoning migration 018 gives `schema_migrations` and migration 019 gives `bank_match_suggestions`: high-volume, transient, derived machinery with no compliance value the audited source row (the invoice, the bill) doesn't already carry.

**`021_ledger-core_unmatched_alert_threshold.sql`** adds `ledger_settings.unmatched_alert_threshold_cents` `BIGINT NOT NULL DEFAULT 0`, `CHECK >= 0` — the minimum absolute value of an unmatched bank line's signed `amount_cents` that fires a `bank.large_unmatched` event on import. `DEFAULT 0` means disabled, and every organization — including ones that existed before this migration ran — starts disabled; there is no backfill that turns alerting on for anyone.

**The scheduled integrity check.** Phase 5's `verify:integrity` script (three whole-database invariant checks) now also runs automatically once a day via the background worker's job scheduler, closing the gap Phase 5 recorded — see [Phase 5](#phase-5--shared-cdc-audit-trail--applied) above.

**Not built in this phase:** retention or partitioning on `webhook_deliveries` (the same accepted cost `audit_logs` carries) · `POST /webhooks/:id/test` (a one-off send that would bypass the outbox and be a second, untested delivery path) · a `payment.voided` event (or any event beyond the five named here) · per-endpoint retry policy overrides · Redis-backed per-account rate limiting (Redis is now in use, but the login/register limiter documented in `constants.ts` is still per-IP — that needs `rate-limit-redis`, which is not an approved Phase 7 dependency).

---

## Phase 8 — multi-currency FX engine (LedgerCore) — applied

`022_ledger-core_fx_rates.sql` adds `fx_rates`, the first piece: an organization's own record of exchange rates, entered by hand (`source = 'MANUAL'`) or by a future import (`source = 'IMPORT'`).

**`fx_rates`** — `id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `from_code` CHAR(3) · `to_code` CHAR(3) · `rate_date` DATE · `rate` NUMERIC(18,8) · `source` TEXT DEFAULT `'MANUAL'` CHECK IN (`MANUAL`,`IMPORT`) · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` / `updated_at`. `ux_fx_rates_org_pair_date` — `UNIQUE (org_id, from_code, to_code, rate_date)`. `chk_fx_rates_from_code`/`chk_fx_rates_to_code` — each a 3-letter uppercase CHECK. `chk_fx_rates_different` — `from_code <> to_code`. `chk_fx_rates_rate_range` — `rate > 0 AND rate <= 1000000`, chosen so a rate's integer numerator (`rate x 1e8`, `utils/fxRate.ts`'s `RATE_SCALE`) stays inside `Number.MAX_SAFE_INTEGER`. `idx_fx_rates_lookup` — `(org_id, from_code, to_code, rate_date DESC)`, the only index this table needs: every read is "the latest rate for this pair on or before a date," never an exact-date match, because rate feeds have gaps on weekends and holidays.

**Deliberately changed from the original Phase 8+ sketch below:** the sketch called for a single global table with no `org_id`, reasoning that an exchange rate is "a fact about the world." The phase as built instead makes `fx_rates` **org-scoped**, `ON DELETE CASCADE` like `vendors`/`customers` rather than `RESTRICT` like `journal_entries` — a rate is reference data an organization enters for itself (there is no external rate-feed integration in this phase, deliberately: no approved outbound-API dependency, no key management), so two organizations may disagree about USD/INR on the same date, and rule 1's "every query is scoped by `org_id`" is honored rather than carved out a second time. `from_code`/`to_code` replace the sketch's `base_code`/`quote_code` to avoid colliding with `organizations.base_currency`, a different "base."

A rate row means: **one unit of `from_code` buys `rate` units of `to_code`.** Every rate in this system is recorded foreign → base (the organization's `base_currency`), so converting a native amount to base is always a multiplication (`utils/fxRate.ts`'s `convertToBase`, via `scaleCents` — exact `BigInt`, half-up), never an inversion.

**Audited** — `trg_fx_rates_audit` runs `audit_row_change('ledger-core')`; a rate is financial reference data, not derived/regenerated machinery like `bank_match_suggestions`.

**`023_ledger-core_base_currency_balance.sql`** — "base currency is what balances." Redefines `assert_journal_entry_balanced()` (004) — `004` itself is not edited, and its checksum is unchanged; the two `CONSTRAINT TRIGGER`s it created pick up the new function body automatically. The **base-currency** sum check (`SUM(base_debit_cents) = SUM(base_credit_cents)`) is now unconditional, on every entry, always. The **native-currency** sum check now fires only when `COUNT(DISTINCT currency_code) = 1` across the entry's lines — every entry Phases 3–7 ever wrote, and every base-currency entry this phase and later ones write, is still checked exactly as strictly as before. A realized-FX settlement entry legitimately mixes a foreign-currency receivable line with a base-currency gain/loss line (see [ledger-core.md § 3](accounting.md#3-realized-fx--the-worked-example)); summing those native amounts together would be meaningless, so only the base-currency sum is asked to balance for it. This is the standard functional-currency accounting rule. See [study/postgresql/multi-currency-and-functional-currency.md](../study/postgresql/multi-currency-and-functional-currency.md).

Also adds `chk_ledger_lines_base_matches_rate` on `ledger_lines`: `CHECK (base_debit_cents = round(debit_cents * fx_rate) AND base_credit_cents = round(credit_cents * fx_rate))`. Valid against the whole table with no backfill, since every pre-Phase-8 row was written at `fx_rate = 1`. Postgres `round(numeric)` rounds half away from zero — the same rule `utils/money.ts`'s `scaleCents` (via `utils/fxRate.ts`'s `convertToBase`) applies for the non-negative amounts every ledger line holds, which is what lets the service and the database agree to the cent on every conversion.

`journalService.createEntryOnClient` resolves each line's currency and rate (omitted means the organization's base currency at rate `1.00000000`, byte-identical to the pre-Phase-8 behaviour), converts every line to base with `convertToBase`, and pre-checks both the conditional native sum and the unconditional base sum before ever reaching the database — the same "checked twice, service and trigger" doctrine every other invariant in this schema follows.

**`024_ledger-core_document_fx.sql`** — foreign-currency `invoices`/`bills`. Each table gains `fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1` and `base_subtotal_cents`/`base_tax_cents`/`base_total_cents BIGINT NOT NULL DEFAULT 0`, backfilled from the native `subtotal_cents`/`tax_cents`/`total_cents` for every pre-existing row (all of them at `fx_rate = 1`, so base already equals native). `chk_invoices_fx_rate`/`chk_bills_fx_rate` mirror `chk_fx_rates_rate_range`. `chk_invoices_base_total`/`chk_bills_base_total` require `base_total_cents = base_subtotal_cents + base_tax_cents` — **deliberately not** `base_total_cents = round(total_cents * fx_rate)`: the base total is the sum of two independently-rounded components (subtotal and tax), which may legitimately differ from the rounded total by a cent, and the actual rate-agreement CHECK lives on `ledger_lines` (023), built from those same per-component amounts.

`invoiceService`/`billService` resolve the document's rate (identity when its currency matches the org's base currency, otherwise the latest `fx_rates` row on or before the document's date) on every draft save — so a draft always displays an honest base-currency total — and **freeze** it again at `issue`/`approve`, re-resolved against the actual posting date (which can differ from the document's own date via `entryDate`). Once posted, the rate never changes; every later settlement compares its own rate against this frozen one. The posted journal entry's lines carry the document's own `currency_code` and frozen `fx_rate`, converted to base currency via `utils/fxRate.ts`'s `convertToBase` — a foreign-currency invoice or bill posts real foreign-currency amounts, not a base-currency approximation.

**`025_ledger-core_payment_fx.sql`** — foreign-currency `payments`, realized-FX posting accounts, and the allocation currency guard.

`payments` gains `fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1` and `base_amount_cents BIGINT NOT NULL DEFAULT 0` (backfilled from `amount_cents` for every pre-existing row); `chk_payments_fx_rate` mirrors `chk_fx_rates_rate_range`. `payment_allocations` gains `base_amount_cents BIGINT NOT NULL DEFAULT 0` — a **deliberate exception** to this codebase's "derive, never store" discipline (see [study/architecture/derived-vs-stored-state.md](../study/architecture/derived-vs-stored-state.md)): recomputing a rounded conversion at read time could drift from the ledger line's own `base_debit_cents`/`base_credit_cents` by a cent, and a subledger that does not tie to the GL to the cent is worse than one redundant column.

`ledger_settings` gains three nullable composite-FK columns mirroring `012`'s AP posting accounts exactly — `realized_fx_gain_account_id`, `realized_fx_loss_account_id`, `unrealized_fx_account_id`, each `FOREIGN KEY (org_id, *) REFERENCES accounts (org_id, id) ON DELETE RESTRICT`, each indexed. Unlike `012`'s columns (which have no read/write path through the API to this day), Phase 8 exposes all three through `GET`/`PATCH /settings` — see [api.md](api.md). `NULL` falls back to chart codes `4910`/`6810`/`6820` in the service, seeded for every organization since Phase 3.

**`trg_allocations_currency`** (`assert_allocation_currency_matches()`) — a plain `BEFORE INSERT` trigger on `payment_allocations`: a payment may only allocate to a document sharing its own `currency_code`. Deliberately returns `NEW` without raising (leaving the outcome to `chk_allocation_one_target` or the composite FKs) when neither target is set or the target id doesn't resolve to a row in this org — a `BEFORE` trigger fires ahead of `CHECK`/FK validation, so raising unconditionally would preempt those constraints' own, more specific errors for a malformed row. Both of its lookups carry `org_id`, so it is a tenancy boundary as well as a currency one.

**`paymentService.createPaymentOnClient`'s realized-FX plug**, the mechanism this migration exists to support: for a foreign-currency payment, `imbalance = Σ(line base debits) − Σ(line base credits)` over the cash line (native currency at the settlement-date rate) and one control line per allocation (native currency at *that document's own frozen rate*). `imbalance > 0` credits `4910 Realized FX Gain`; `imbalance < 0` debits `6810 Realized FX Loss`; `imbalance = 0` posts no FX line at all. One subtraction handles both a receivable settled high (a gain) and a payable settled high (a loss, the mirror case) with no direction-specific sign branch — see [ledger-core.md § 3](accounting.md#3-realized-fx--the-worked-example) and [study/architecture/realized-and-unrealized-fx.md](../study/architecture/realized-and-unrealized-fx.md). A base-currency payment's GL shape is untouched — still exactly the two lines Phase 3.9 posted.

**`026_ledger-core_fx_revaluations.sql`** — period-end unrealized revaluation, closing out Phase 8.

**`fx_revaluations`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE RESTRICT · `as_of_date` DATE · `journal_entry_id`/`reversal_journal_entry_id` UUID NOT NULL, each a composite FK → `journal_entries (org_id, id)` ON DELETE RESTRICT · `total_delta_cents` BIGINT **signed** (no `>= 0` CHECK — a revaluation delta is not a "money ≥ 0" amount, matching `bank_transactions.amount_cents` rather than every other money column in this schema) · `line_count` INTEGER `CHECK (> 0)` · `created_by`/`created_at`. `ux_fx_revaluations_org_date` — `UNIQUE (org_id, as_of_date)`, what `POST /fx-revaluations` turns into a `409` on a repeat date.

**`fx_revaluation_lines`** — one row per open foreign-currency document included in a revaluation: `revaluation_id` composite FK → `fx_revaluations (org_id, id)` ON DELETE CASCADE (the detail dies with its parent) · `invoice_id` XOR `bill_id` (`chk_fx_revaluation_line_one_target`, the same idiom as `payment_allocations`) · `currency_code`, `outstanding_cents`, `document_rate`, `revaluation_rate`, `carrying_base_cents`, `revalued_base_cents`, and a signed `delta_cents`.

**Deliberately no status column and no FSM** — unlike every other lifecycle table in this schema. A revaluation is created posted and stays posted forever; a wrong one is corrected by the *next* period's revaluation, the same way an accountant would, never by editing or voiding this one.

**Audited on the parent only.** `fx_revaluation_lines` is derived data computed at the moment a revaluation runs and never regenerated in place — closer to `payment_allocations` (a permanent record) than to `bank_match_suggestions` (deleted and rewritten wholesale on every rescore), but the parent row's own `total_delta_cents`/`line_count` already summarize it for compliance purposes, so only `fx_revaluations` carries `audit_row_change('ledger-core')`.

**`fxRevaluationService.runRevaluation`** posts one journal entry dated `asOfDate` restating every open foreign-currency invoice/bill at the as-of exchange rate, through `6820 Unrealized FX Gain/Loss` — **a single account for both directions**, unlike the realized `4910`/`6810` pair, because an unrealized revaluation is one economic event regardless of which way it moves. Uses the same imbalance-as-plug technique as `paymentService.createPaymentOnClient`'s realized settlement: build the AR/AP restatement lines from each document's `(revaluedBase − carryingBase)` delta, then let `6820` absorb whatever those lines don't already balance. Immediately posts a **second** entry — `journalService.reverseEntryOnClient` dated the calendar day after `asOfDate` — reversing the first. That reversal is what keeps *realized* FX correct at the next real settlement: `paymentService` always compares a payment's rate against the document's **original frozen** `fx_rate`, never against a revalued carrying amount, and the next-day reversal is what guarantees the revaluation's effect does not linger into that comparison. See [ledger-core.md § 3](accounting.md#3-realized-fx--the-worked-example) and [study/architecture/realized-and-unrealized-fx.md](../study/architecture/realized-and-unrealized-fx.md).

`GET /reports/fx-exposure` runs the identical computation read-only — same query, same per-currency rate resolution, zero writes — so a user can preview a revaluation's effect before committing to it.

This closes Phase 8's scope as specified in [ledger-core.md § D](accounting.md#d-multi-currency-fx-engine--phase-8): `fx_rates` and the latest-on-or-before lookup (022), base currency as the balancing invariant (023), foreign-currency invoices and bills (024), foreign-currency payments with realized settlement gain/loss (025), and period-end unrealized revaluation (026).

---

## Phase 9a — platform onboarding state — applied

`027_platform_onboarding_states.sql` adds `onboarding_states`, one row per `(org_id, app_slug)`.

**`onboarding_states`** — `id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `app_slug` TEXT NOT NULL (non-blank CHECK, `<= 40` chars) · `status` TEXT DEFAULT `'NOT_STARTED'` CHECK IN (`NOT_STARTED`,`IN_PROGRESS`,`SKIPPED`,`COMPLETED`) · `current_step` TEXT nullable, `<= 60` chars · `draft` JSONB NOT NULL DEFAULT `'{}'::jsonb`, CHECK `jsonb_typeof(draft) = 'object'` · `completed_at`/`skipped_at` TIMESTAMPTZ nullable · timestamps. `ux_onboarding_states_org_app` — `UNIQUE (org_id, app_slug)` (not a composite PK — the row still has its own UUID `id`, matching this schema's convention everywhere else). `idx_onboarding_states_org` on `org_id`.

`app_slug` carries **no** `REFERENCES` and no enumerated CHECK — validated against `isOnboardingSlug` (`isAppSlug` plus a `'platform'` sentinel for the suite-level wizard) in the service, the same call migration 017 made for `audit_logs.app_slug`. `draft` is untrusted JSON, bound as one parameter everywhere it's written, never spread into a query. `COMPLETED` is deliberately **not** terminal — `ONBOARDING_TRANSITIONS` allows `COMPLETED → IN_PROGRESS`, since re-running a completed wizard is already legal (`settingsService.completeOnboarding` is an upsert). `trg_onboarding_states_updated_at` (`set_updated_at`) and `trg_onboarding_states_audit` (`audit_row_change('platform')`).

## Phase 9b — chart & opening-balance import (LedgerCore) — applied

`028_ledger-core_opening_balance_equity.sql` adds `3400 Opening Balance Equity` to `DEFAULT_CHART` and backfills every existing organization, structured like migration 003. **The default chart becomes 45 accounts.** It exists because opening balances cannot be plugged to `3200 Retained Earnings`: `reportService.balanceSheet` derives retained earnings from revenue and expense before the fiscal year start, and its own comment warns that anything posted to `3200` is counted twice.

`029_ledger-core_migration_imports.sql` adds the staged importer, deliberately shaped against Phase 6's bank import: that one aborts the whole file on the first bad row and writes live rows immediately; this one stages every row, good and bad, and separates validation from commit.

**`migration_imports`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE RESTRICT · `kind` TEXT CHECK IN (`CHART_OF_ACCOUNTS`,`OPENING_BALANCES`) · `status` TEXT DEFAULT `'DRAFT'` CHECK IN (`DRAFT`,`VALIDATED`,`COMMITTED`) · `file_name`/`delimiter` · `row_count`/`error_count` INTEGER · `journal_entry_id` UUID nullable, composite FK → `journal_entries (org_id, id)` ON DELETE RESTRICT · `committed_at` TIMESTAMPTZ nullable · `created_by` FK → `users` ON DELETE RESTRICT · timestamps. `ux_migration_imports_org_id_id` — `UNIQUE (org_id, id)`, what makes the composite FK from `migration_import_rows` legal. `chk_migration_imports_error_count` — `error_count <= row_count`. `chk_migration_imports_committed` — `(status = 'COMMITTED') = (committed_at IS NOT NULL)`, the same "posted-complete" idiom `chk_bills_posted_complete`/`chk_fiscal_periods_locked_complete` use. `chk_migration_imports_entry_kind` — `journal_entry_id IS NULL OR kind = 'OPENING_BALANCES'`, since a chart import never posts to the GL.

**A partial unique index**, not a service check — `ux_migration_imports_one_committed_opening`: `UNIQUE (org_id) WHERE kind = 'OPENING_BALANCES' AND status = 'COMMITTED'`. Allows exactly one committed opening-balance import per organization, ever; a wrong one is corrected by a reversing journal entry (rule 6), never by re-importing. A `CHART_OF_ACCOUNTS` import carries no such limit — merging a chart via a separate, later import is legal. See [study/postgresql/partial-unique-indexes.md](../study/postgresql/partial-unique-indexes.md).

**`migration_import_rows`** — `id` UUID PK · `org_id` FK ON DELETE RESTRICT · `import_id` UUID NOT NULL, composite FK → `migration_imports (org_id, id)` ON DELETE CASCADE · `row_number` INTEGER `CHECK (>= 2)` (header row counted) · `raw` JSONB NOT NULL DEFAULT `'{}'::jsonb` (the row's fields as originally parsed, canonical-keyed, for showing a validation error against the actual input) · `account_code`/`account_name`/`parent_code`/`description` TEXT, each nullable with a length CHECK · `account_type` TEXT nullable, CHECK IN the five account types · `debit_cents`/`credit_cents` BIGINT nullable, each `CHECK (IS NULL OR >= 0)` · `errors` TEXT[] NOT NULL DEFAULT `'{}'` · `status` TEXT DEFAULT `'INVALID'` CHECK IN (`VALID`,`INVALID`,`EXCLUDED`) · timestamps. `ux_migration_rows_import_row` — `UNIQUE (org_id, import_id, row_number)`. `chk_migration_rows_one_side` — at most one of `debit_cents`/`credit_cents` may be non-zero, rule 7's shape applied to staged data. `chk_migration_rows_valid_has_no_errors` — `status <> 'VALID' OR cardinality(errors) = 0`, so a row can never claim to be valid while still carrying a recorded error.

`trg_migration_imports_updated_at`/`trg_migration_rows_updated_at` (`set_updated_at`) on both tables. **Audited on the parent only** — `trg_migration_imports_audit` runs `audit_row_change('ledger-core')` on `migration_imports`; `migration_import_rows` carries **no** audit trigger, the same exemption `bank_match_suggestions` and `fx_revaluation_lines` carry — it's staging data, rewritten wholesale on every re-validate, and what it ultimately produces (real accounts, a real journal entry) is itself audited.

**Neither table has an immutability trigger.** A `COMMITTED` import's row-level fields are not database-enforced read-only the way `invoices`/`bills`/`payments` are past their own posted state — `chk_migration_imports_committed` and `chk_migration_imports_entry_kind` protect specific invariants, but nothing stops a raw `UPDATE` from changing, say, a committed import's `file_name`. The service layer never issues such an `UPDATE` (every write path checks `status !== 'COMMITTED'` first), but this is a real gap relative to the immutability discipline the rest of the schema enforces at the database layer — recorded honestly rather than papered over.

See [ledger-core.md § Phase 9b](accounting.md#phase-9b--chart--opening-balance-import) for the commit semantics (parent-before-child chart resolution, the imbalance-as-plug computation, the three refused accounts) and [api.md](api.md#migration-imports--apiv1ledger-coremigration-imports--phase-9b) for the routes.

## Phase 9.5 — the Document Vault (platform) — applied

`030_platform_documents.sql` adds `documents` and `document_links`, the suite-wide file vault. Both are platform tables, unprefixed — LedgerCore attaching a PDF and AP-Flow attaching a source image (Phase 10) are both apps talking to the platform, never to each other, which is what keeps guardrails rule 16 intact.

**`documents`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `sha256` CHAR(64) NOT NULL, CHECK `sha256 ~ '^[0-9a-f]{64}$'` (lowercase hex only — this CHECK is what lets `storageService.blobPath` treat the value as a safe path segment) · `byte_size` BIGINT NOT NULL CHECK `> 0` · `mime_type` TEXT NOT NULL, CHECK IN (`application/pdf`,`image/png`,`image/jpeg`,`text/csv`) · `original_filename` TEXT NOT NULL, non-blank CHECK, `<= 255` chars · `uploaded_by` FK → `users` ON DELETE RESTRICT · `created_at` TIMESTAMPTZ NOT NULL DEFAULT `now()`. **No `updated_at`** — the row is never updated (see immutability, below), so a `set_updated_at` trigger would be decorative. `ux_documents_org_sha` — `UNIQUE (org_id, sha256)`, what makes upload idempotent per tenant: re-uploading identical bytes returns the existing row rather than erroring. `ux_documents_org_id_id` — `UNIQUE (org_id, id)`, the composite target `document_links` references.

**`document_links`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `document_id` UUID NOT NULL · `app_slug` TEXT NOT NULL, non-blank CHECK, `<= 40` chars (no `REFERENCES` and no enumerated CHECK — validated against `isAppSlug` in the service, the same call migrations 017/027 made) · `entity_type` TEXT NOT NULL, non-blank CHECK, `<= 40` chars · `entity_id` UUID NOT NULL · `created_by` FK → `users` ON DELETE RESTRICT · `created_at` TIMESTAMPTZ NOT NULL DEFAULT `now()`. `fk_document_links_document` — composite FK `(org_id, document_id) → documents (org_id, id)` ON DELETE CASCADE, making a cross-tenant link unrepresentable at the schema level (the same composite-FK-for-tenancy technique migration 005 uses). `ux_document_links_target` — `UNIQUE (org_id, document_id, app_slug, entity_type, entity_id)`.

**`entity_id` carries no `REFERENCES`, deliberately.** Foreign-keying it to an app's own table would mean the platform reading that app's schema directly, which rule 16 forbids — a link can in principle outlive the entity it points at (an attached invoice later hard-deleted, say), and that is accepted and tested (`documentConstraints.test.ts`) rather than prevented.

**Immutability: update-immutable by trigger, not insert-only.** `reject_document_mutation()` (`BEFORE UPDATE`, raising `0A000`) is attached to both tables — a document's metadata describes content-addressed bytes already on disk, and editing the row would make it describe a file that no longer matches. **DELETE stays legal on both tables**: `DELETE /documents/:id` is a real route, refused by `documentService` (`409`) while any `document_links` row still references it, never by a trigger. This is a correction from this section's earlier planned wording, which said "insert-only" — the shipped design needed a real deletion path once an attachment is removed, so only UPDATE is blocked.

Both tables audited with `trg_documents_audit`/`trg_document_links_audit` (`audit_row_change('platform')`).

The bytes themselves are never in Postgres — `services/storageService.ts` writes them to the filesystem under `STORAGE_ROOT/<org_id>/<sha[0:2]>/<sha[2:4]>/<sha256>` (gitignored), org-keyed rather than globally content-addressed so two tenants uploading identical bytes never share a blob. See [study/architecture/file-storage-and-streaming.md](../study/architecture/file-storage-and-streaming.md) and [api.md](api.md#documents--apiv1documents--phase-95) for the routes.

## Phase 10 — AP-Flow capture & extraction — applied

`031_ap-flow_documents.sql` adds three tables — one more than the phase's original sketch, and structured differently in two other ways the sketch didn't anticipate: no `ap_flow_documents.redaction_status`/`redacted_regions` (those moved to the new per-page table), and `ap_flow_extractions` holds **one current row per document**, replaced wholesale on re-extraction, not one row per attempt.

**`ap_flow_documents`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `document_id` UUID NOT NULL, composite FK `(org_id, document_id) → documents (org_id, id)` ON DELETE CASCADE (the platform vault row this registers — bytes, hash, MIME type and filename all live there, never duplicated here) · `status` TEXT NOT NULL DEFAULT `'PENDING'`, CHECK IN (`PENDING`,`PROCESSING`,`EXTRACTED`,`FAILED`) originally, widened to add `POSTED` in migration 032 (Phase 11 — see below) and `DUPLICATE` in migration 054 (Phase 19.4 — see below) · `page_count` INT NULL, CHECK `> 0` when present · `failure_reason` TEXT NULL, `<= 1000` chars · `processing_started_at`/`processed_at` TIMESTAMPTZ NULL · `created_by` FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at` TIMESTAMPTZ NOT NULL DEFAULT `now()`, `updated_at` bumped by a `set_updated_at` trigger. `ux_ap_flow_documents_document` — `UNIQUE (org_id, document_id)` originally, **dropped in migration 054 (Phase 19.4)**. `ux_ap_flow_documents_org_id_id` — the composite target the other two tables reference.

**`ap_flow_pages`** — one row per rasterized/redacted page. `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `ap_flow_document_id` UUID NOT NULL, composite FK → `ap_flow_documents (org_id, id)` ON DELETE CASCADE · `page_number` INT NOT NULL CHECK `>= 1` · `width_px`/`height_px` INT NOT NULL CHECK `> 0` · `redacted_sha256` CHAR(64) NOT NULL, CHECK lowercase hex (the hash of the **redacted** page, stored back through `storageService.put` — the unredacted raster is never persisted anywhere) · `ocr_text` TEXT NOT NULL (the unredacted local OCR text — stored, but **never returned by the API**; returning it would undo the redaction) · `redacted_regions` JSONB NOT NULL DEFAULT `'[]'` (the exact boxes masked, with their PII kind, so the redaction decision is itself auditable) · `created_at`. `ux_ap_flow_pages_number` — `UNIQUE (org_id, ap_flow_document_id, page_number)`.

**`ap_flow_extractions`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `ap_flow_document_id` UUID NOT NULL, composite FK → `ap_flow_documents (org_id, id)` ON DELETE CASCADE · `vendor_name`/`invoice_number` TEXT NULL, length-capped · `invoice_date` DATE NULL · `currency` CHAR(3) NULL, CHECK `~ '^[A-Z]{3}$'` · `subtotal_cents`/`tax_cents`/`total_cents` BIGINT NULL, CHECK `>= 0` · `line_items` JSONB NOT NULL DEFAULT `'[]'` · `field_confidence` JSONB NOT NULL DEFAULT `'{}'` (0–1 per field, what Phase 11's review UI will colour) · `arithmetic_ok` BOOLEAN NOT NULL (line items vs. subtotal, subtotal+tax vs. total — flagged, never silently accepted or auto-rejected, since Phase 10 posts nothing to reject) · `validation_errors` JSONB NOT NULL DEFAULT `'[]'` · `model` TEXT NOT NULL, non-blank CHECK · `created_at`. `ux_ap_flow_extractions_document` — `UNIQUE (org_id, ap_flow_document_id)`: **one current extraction per document**, not a history table — a re-extraction `DELETE`s the old row and `INSERT`s a fresh one inside the same transaction that moves `status` to `EXTRACTED`. What a prior attempt said survives only in `audit_logs`.

**Immutability, narrower than a posted financial document's (rule 6 is about posted documents; these are pre-posting drafts).** `reject_ap_flow_mutation()` (`BEFORE UPDATE`, raising `0A000`) is attached to `ap_flow_pages` and `ap_flow_extractions` — what the model said on a given run stays non-repudiable. **`DELETE` stays legal on both** — re-extraction depends on it — refused nowhere by a trigger; the service deletes and re-inserts inside one transaction. `ap_flow_documents.status` itself is mutable (a plain column, no immutability trigger) as of Phase 10, gated instead by `AP_FLOW_DOCUMENT_TRANSITIONS`, the FSM table in `types/capture.ts`. Phase 11 (below) adds this table's first terminal state and a matching trigger.

**`ap_flow_documents` and `ap_flow_extractions` are audited** (`trg_ap_flow_documents_audit`/`trg_ap_flow_extractions_audit`, `audit_row_change('ap-flow')`). **`ap_flow_pages` is deliberately not audited** — it is derived raster/OCR output, regenerated wholesale on every re-extraction, the same ruling `bank_match_suggestions` got in migration 019.

See [api.md](api.md#ap-flow--apiv1ap-flow--phases-1011) for the routes, [study/architecture/document-capture-pipeline.md](../study/architecture/document-capture-pipeline.md) for the rasterize → OCR → redact → extract pipeline, and [study/security-auth/pii-detection-and-redaction.md](../study/security-auth/pii-detection-and-redaction.md) for the masking mechanism.

## Phase 11 — AP-Flow mapping, review & posting — applied

`032_ap-flow_mapping_and_posting.sql` widens `ap_flow_documents.status`'s CHECK to add `POSTED` — its first terminal state — and adds two tables.

**`ap_flow_documents` gains four columns**: `journal_entry_id` UUID NULL (the LedgerCore entry this document posted, **no `REFERENCES`** — see the no-FK ruling below) · `posted_sha256` CHAR(64) NULL, CHECK lowercase hex when present (the vault document's own hash, frozen at posting) · `posted_at` TIMESTAMPTZ NULL · `posted_by` UUID NULL FK → `users` ON DELETE RESTRICT. `chk_ap_flow_documents_posted_complete` — CHECK `status <> 'POSTED' OR (journal_entry_id IS NOT NULL AND posted_sha256 IS NOT NULL AND posted_at IS NOT NULL AND posted_by IS NOT NULL)` — a row cannot claim `POSTED` without every fact that status implies.

**`ap_flow_line_items`** — one row per extracted line, materializing what used to be JSONB-only on `ap_flow_extractions.line_items`. `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `ap_flow_document_id` UUID NOT NULL, composite FK → `ap_flow_documents (org_id, id)` ON DELETE CASCADE · `line_index` INT NOT NULL CHECK `>= 0` · `description` TEXT NOT NULL, `<= 500` chars · `amount_cents` BIGINT NOT NULL (**no `>= 0` CHECK** — a credit-note line legitimately reads negative; the posting service refuses a non-positive document total instead) · `account_id` UUID NULL (**no `REFERENCES`** — see below) · `suggested_account_id` UUID NULL · `mapping_source` TEXT NOT NULL DEFAULT `'NONE'`, CHECK IN (`HISTORY`,`CHART`,`MODEL`,`MANUAL`,`NONE`) · `mapping_confidence` NUMERIC(4,3) NULL, CHECK `0 <= x <= 1` · `created_at`/`updated_at`, `updated_at` bumped by `set_updated_at`. `ux_ap_flow_line_items_index` — `UNIQUE (org_id, ap_flow_document_id, line_index)`.

**`ap_flow_vendor_account_map`** — the organization's own posting history, consulted before any model is asked to classify. `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `vendor_key` TEXT NOT NULL, non-blank, `<= 200` chars (`normalizeForMatching(vendorName)` — never `vendors.id`; AP-Flow does not read LedgerCore's vendor table, rule 16) · `account_id` UUID NOT NULL (**no `REFERENCES`**) · `hit_count` INT NOT NULL DEFAULT 1, CHECK `>= 1` · `last_used_at`/`created_at`/`updated_at`. `ux_ap_flow_vendor_map_key` — `UNIQUE (org_id, vendor_key)`.

**Why `account_id` carries no `REFERENCES` here, unlike everywhere else in the schema (rule 8's usual reading).** Rules 8 and 16 collide on this column, and 16 wins — the same ruling `journal_entries.source_id` and `document_links.entity_id` already carry. A schema-level FK from an AP-Flow table into LedgerCore's `accounts` table would hard-wire the app boundary into the database itself; AP-Flow is not supposed to know LedgerCore's schema at that level. Validity is enforced at the service layer instead, three times over: `accountService.getAccountById` on override (`404` cross-tenant) and at classification time, and definitively `journalService.createEntryOnClient`'s `assertAccountsArePostable` inside the posting transaction. This is safe because accounts are never actually deleted in this codebase — retired via `is_active = false` — so a dangling `account_id` is not a reachable state. `journal_entry_id` on `ap_flow_documents` gets the identical ruling, for the identical reason.

**Line items are mutable, unlike their Phase 10 siblings — until their parent document posts.** `trg_ap_flow_line_items_posted_guard` (`BEFORE UPDATE OR DELETE`, mirroring `invoice_lines`' `reject_non_draft_invoice_line_mutation()`) reads the parent `ap_flow_documents.status`: any status but `POSTED` passes the mutation through, `POSTED` raises `0A000`. A `NULL` parent status (the row is already gone via cascade) passes through too — the same authorised-cascade carve-out `invoice_lines` uses. `trg_ap_flow_documents_posted_guard` gives `ap_flow_documents` itself the same terminal treatment: once `OLD.status = 'POSTED'`, every `UPDATE` is refused, with no carve-out at all — unlike `invoices`' `ISSUED → VOID` exception, nothing may change once posted.

**Both new tables are audited** (`trg_ap_flow_line_items_audit`/`trg_ap_flow_vendor_map_audit`) — unlike `ap_flow_pages`, a reviewer's account override and a posting's vendor-history write are business state, not derived raster output.

See [api.md](api.md#ap-flow--apiv1ap-flow--phases-1011) for the routes.

## Phase 19 — AP-Flow automated intake — applied

`048_ap-flow_extraction_due_date.sql`, `049_ap-flow_bill_posting.sql`, `050_ap-flow_auto_post.sql`.

**`ap_flow_extractions` gains one column**: `due_date` DATE NULL. `ADD COLUMN` with no `DEFAULT` and nullable adds no data and rewrites nothing on a populated table; this table is otherwise unchanged, including its update-immutability trigger from migration 031.

**`ap_flow_documents` gains three columns**: `bill_id` UUID NULL (the LedgerCore bill this document posted as — **no `REFERENCES`**, the identical rule-16-over-rule-8 ruling `journal_entry_id` already carries) · `auto_posted` BOOLEAN NOT NULL DEFAULT `false` (true when auto-post, not a human, approved the posting) · `auto_post_blockers` JSONB NOT NULL DEFAULT `'[]'`, CHECK `jsonb_typeof(auto_post_blockers) = 'array'` (the exact reasons a clean-looking extraction did not auto-post — reset to `'[]'` on re-extraction and on reaching `EXTRACTED`). `idx_ap_flow_documents_bill` — a partial index `ON ap_flow_documents (org_id, bill_id) WHERE bill_id IS NOT NULL`. All three `ADD COLUMN`s use a constant or no default, so — per PostgreSQL 11+'s fast-default optimization — no row is rewritten and no `UPDATE` fires, meaning `trg_ap_flow_documents_posted_guard` (migration 032) never sees these columns land on an existing `POSTED` row; a real backfilling `UPDATE` would have been rejected by that trigger. Pre-Phase-19 `POSTED` rows legitimately keep `bill_id NULL` and `auto_posted false` — they posted a raw journal entry, not a bill.

**`ap_flow_settings`** — this app's first per-org settings row, one per organization, mirroring `ledger_settings`'s shape. `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `auto_post_enabled` BOOLEAN NOT NULL DEFAULT `false` · `auto_post_min_confidence` NUMERIC(4,3) NOT NULL DEFAULT `0.900`, CHECK `0.500..1.000` · `auto_post_max_total_cents` BIGINT NULL, CHECK `> 0` when present (`NULL` = no limit) · `updated_by` UUID NULL FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at`, bumped by `set_updated_at`. `ux_ap_flow_settings_org` — `UNIQUE (org_id)`, one settings row per organization. Audited (`trg_ap_flow_settings_audit`).

**Why AP-Flow now posts a bill, not a raw journal entry.** Phase 11's `postingService.ts` credited the AP control account (`2100`) directly via `journalService.createEntryOnClient`, with no subledger document behind it. That broke `agingService.apAging`'s reconciliation (the subledger side sums open `bills`; the control-account side sums `ledger_lines` — the two diverged the moment AP-Flow posted anything) and meant an AP-Flow-originated payable could never be paid through `/payments`. Phase 19 reroutes posting through `billService`'s two newly-exported `*OnClient` functions (`createCapturedBillOnClient`, `approveBillOnClient`) called on `postingService`'s own transaction — the identical `*OnClient` pattern `journalService.createEntryOnClient` already established. `source_type` on the resulting `journal_entries` row is now `'bill'`, `source_id` the bill's id, exactly as if a human had entered and approved that bill directly. See [study/postgresql/subledger-reconciliation-and-aging.md](../study/postgresql/subledger-reconciliation-and-aging.md).

**Tax allocation across lines** uses `utils/money.ts`'s new `allocateCents` (largest-remainder method, exact `BigInt` arithmetic) rather than `scaleCents` applied per line — independent per-line roundings do not generally re-sum to the document-level tax total, and `bills.chk_bills_total`-style invariants require them to.

**Vendor resolution** (`vendorService.findOrCreateVendorByNameOnClient`) matches an existing active vendor by `normalizeForMatching`-equal name (same normalization `ap_flow_vendor_account_map.vendor_key` already uses) or creates one, serialized per `(org, normalized name)` by a transaction-scoped `pg_advisory_xact_lock` — `vendors.name` carries no `UNIQUE` constraint, so two concurrent captures of a brand-new vendor name would otherwise both pass a plain `SELECT` check and both `INSERT`.

See [api.md](api.md#ap-flow--apiv1ap-flow--phases-1011-19) for the routes, and [capture.md](capture.md) for the auto-post gate list and the multi-provider extraction seam.

## Phase 19.1 — AI token/cost metering — applied

`051_platform_ai_model_calls.sql`.

**`ai_model_calls`** — a **platform table**, not namespaced under any app (`app_slug` carries the namespace, the same convention `document_links`/`audit_logs` already use — guardrails rule 16). `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `app_slug` TEXT NOT NULL, `1..50` chars · `purpose` TEXT NOT NULL, CHECK IN (`EXTRACT`,`CLASSIFY`,`ANSWER`,`EMBED`) · `provider` TEXT NOT NULL, CHECK IN (`anthropic`,`gemini`,`voyage`) · `model` TEXT NOT NULL, non-blank, `<= 100` chars · `entity_type` TEXT NULL, `<= 50` chars · `entity_id` UUID NULL (**no `REFERENCES`** — see below) · `input_tokens`/`output_tokens`/`cached_input_tokens`/`reasoning_tokens`/`total_tokens` BIGINT NOT NULL DEFAULT `0`, each CHECK `>= 0` · `cost_micro_usd` BIGINT NULL, CHECK `>= 0` when present (millionths of one USD — see `utils/microUsd.ts`; never `Cents`, never posted to the GL) · `pricing_version` TEXT NULL, `<= 40` chars · `status` TEXT NOT NULL, CHECK IN (`OK`,`ERROR`) · `error_code` TEXT NULL, `<= 100` chars · `latency_ms` INT NOT NULL, CHECK `>= 0` · `created_by` UUID NULL FK → `users` ON DELETE RESTRICT · `created_at`. `idx_ai_model_calls_org_created`, `idx_ai_model_calls_org_app_created`, a partial `idx_ai_model_calls_entity` (`WHERE entity_id IS NOT NULL`), and `idx_ai_model_calls_created_by`.

**Two CHECKs enforce a discriminated pairing.** `chk_ai_model_calls_cost_pair` — `(cost_micro_usd IS NULL) = (pricing_version IS NULL)`, so "a cost with no pricing version" is unrepresentable: a model absent from `config/aiPricing.ts` records its tokens honestly with both `NULL`, never a fabricated `0`. `chk_ai_model_calls_error` — `(status = 'OK' AND error_code IS NULL) OR (status = 'ERROR' AND error_code IS NOT NULL)`. `chk_ai_model_calls_entity_pair` mirrors the same pattern for `entity_type`/`entity_id`.

**Append-only by trigger, `BEFORE UPDATE` only, never `BEFORE DELETE`.** `reject_ai_model_call_mutation()` raises `0A000` on any `UPDATE`; `DELETE` stays legal so `ON DELETE CASCADE` from `organizations` can still remove an org's rows wholesale — a `BEFORE DELETE` trigger would have blocked that cascade.

**Deliberately NOT audited.** `audit_row_change` snapshots `to_jsonb(NEW)` for UPDATE/DELETE, and this table admits neither by construction — CDC here would only duplicate every INSERT into a second append-only table at the same volume, the same reasoning `ap_flow_pages` (031) and `bank_match_suggestions` (019) already carry.

**Why `entity_id` carries no `REFERENCES`, the identical rule-16-over-rule-8 ruling `document_links.entity_id`/`journal_entries.source_id`/`ap_flow_line_items.account_id` already carry.** A platform table must not hard-wire an FK into an app's own schema — AP-Flow's `ap_flow_documents` today, any future app's own tables tomorrow. Validity is a service-layer concern (`aiUsageService.listCallsForEntity` is read-only and tolerant of a dangling id). The `provider` CHECK still permits `voyage` even though the only app that ever wrote it (TaxGuard AI) was retired in Phase 29 — the CHECK is on an applied, immutable migration (rule 13) and narrowing it needs a new one.

See [api.md](api.md#ai-usage--apiv1ai-usage--phase-191) for the route, and [study/architecture/metering-and-cost-attribution.md](../study/architecture/metering-and-cost-attribution.md).

## Phase 19.2 — AP-Flow Google Drive folder intake — superseded by Phase 19.3

**These two tables were renamed in `053_platform_drive_integration.sql`** when the integration was promoted off AP-Flow to the platform: `ap_flow_drive_connections` → `integration_drive_connections`, `ap_flow_drive_files` → `integration_drive_files`. Every constraint and index kept its old name through the rename (Postgres renames only the table itself) until 053 explicitly renamed those too — see [study/postgresql/migrations-and-schema-evolution.md](../study/postgresql/migrations-and-schema-evolution.md). This section is kept as history — the shape described below is what 052 created, before 053's additions; see [Phase 19.3](#phase-193--drive-folder-intake-promoted-to-a-platform-integration--applied) for the current shape.

`052_ap-flow_drive_intake.sql` adds two tables (original names, pre-rename).

**`ap_flow_drive_connections`** — one per-org OAuth 2.0 + PKCE Drive connection. `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `status` TEXT NOT NULL, CHECK IN (`PENDING_AUTH`,`CONNECTED`,`NEEDS_REAUTH`) · `google_account_email` TEXT NULL, `<= 320` chars · `refresh_token_ciphertext` TEXT NULL (AES-256-GCM, `utils/secretBox.ts`) · `oauth_state_sha256` CHAR(64) NULL, CHECK lowercase hex (a **hash** of the OAuth `state` — the raw value never touches the database) · `pkce_verifier_ciphertext` TEXT NULL · `oauth_state_expires_at` TIMESTAMPTZ NULL · `folder_id` TEXT NULL, CHECK matches Drive's id shape · `folder_name` TEXT NULL, `<= 255` chars · `last_synced_at` TIMESTAMPTZ NULL · `last_sync_error` TEXT NULL, `<= 1000` chars · `connected_by` FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at`, bumped by `set_updated_at`. `ux_ap_flow_drive_connections_org` — `UNIQUE (org_id)`, one connection per tenant. `ux_ap_flow_drive_connections_org_id_id` — the composite target `ap_flow_drive_files` references. A partial unique index `ux_ap_flow_drive_connections_state` on `oauth_state_sha256 WHERE ... IS NOT NULL` makes a state hash collision across two organizations' in-flight connect attempts a constraint violation, not a race. `chk_ap_flow_drive_connections_connected_token` — `status <> 'CONNECTED' OR refresh_token_ciphertext IS NOT NULL`. `chk_ap_flow_drive_connections_state_complete` — the three OAuth-in-flight columns are all-null or all-set together.

**`ap_flow_drive_files`** — the ingestion log: one row per Drive file id ever seen, per org, so a file already imported is never re-imported, even after a folder change or a reconnect. `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `connection_id` UUID NOT NULL, composite FK → `ap_flow_drive_connections (org_id, id)` ON DELETE CASCADE · `drive_file_id` TEXT NOT NULL, CHECK matches Drive's id shape · `name` TEXT NOT NULL, `<= 255` chars · `mime_type` TEXT NOT NULL, `<= 100` chars · `md5_checksum` CHAR(32) NULL, CHECK lowercase hex · `drive_modified_at` TIMESTAMPTZ NULL · `status` TEXT NOT NULL, CHECK IN (`IMPORTED`,`SKIPPED`) · `skip_reason` TEXT NULL, `<= 1000` chars · `ap_flow_document_id` UUID NULL · `created_at`. `ux_ap_flow_drive_files_file` — `UNIQUE (org_id, drive_file_id)`, the once-per-org-ever guarantee. `chk_ap_flow_drive_files_outcome` — the discriminated `IMPORTED`/`skip_reason NULL` vs `SKIPPED`/`skip_reason NOT NULL` pairing.

**`fk_ap_flow_drive_files_document` used the PG15+ column-list `ON DELETE SET NULL (ap_flow_document_id)` form** — nulling only that one column, never `org_id`, when the AP-Flow document it points at is deleted. The plain two-column composite-FK form of `ON DELETE SET NULL` would null **both** columns of the FK, corrupting `org_id` on a row that must stay tenant-scoped forever; see [study/postgresql/composite-foreign-keys-for-tenancy.md](../study/postgresql/composite-foreign-keys-for-tenancy.md) for the trap this avoids. **Phase 19.3 traded this away** — with two possible destination apps instead of one, the FK became a generic `(result_app, result_entity_id)` pair with no `REFERENCES` at all, at the cost of this automatic-null behavior. `ap_flow_document_id` and its FK stay on the renamed table, vestigial, so history already recorded is not lost — see Phase 19.3 below.

**Neither table is audited.** `audit_row_change` snapshots `to_jsonb(NEW)`, which would copy `refresh_token_ciphertext` into an append-only `audit_logs` row forever — an encrypted secret is still a secret, and CDC must never become a second place it leaks to. This reasoning is unchanged after the Phase 19.3 rename.

**Two documented exceptions to guardrails rule 1** live in `services/integrations/driveConnectionService.ts` (moved from `services/capture/` in Phase 19.3), not the schema: the OAuth callback's state lookup (no session exists yet — the state hash *is* the credential) and the scheduler's due-folders query (ids only, every downstream call re-scopes by that row's own `org_id`).

## Phase 19.3 — Drive folder intake promoted to a platform integration — applied

`053_platform_drive_integration.sql`. Renames 052's two tables (mapping above), adds service-account authentication as a second connection mode, and splits the watched folder out of the connection into its own table so one connection can watch many folders, each independently purposed.

**`integration_drive_connections`** (renamed from `ap_flow_drive_connections`) gains `auth_mode` TEXT NOT NULL DEFAULT `'OAUTH'`, CHECK IN (`OAUTH`,`SERVICE_ACCOUNT`). `chk_ap_flow_drive_connections_connected_token` is replaced by `chk_integration_drive_connections_auth_payload`: `OAUTH` ⇒ (`status <> 'CONNECTED'` OR a refresh token is present); `SERVICE_ACCOUNT` ⇒ the refresh token and all three OAuth-in-flight columns are NULL — a service-account connection has no handshake and therefore none of that state, ever. `folder_id`/`folder_name` are left on this table, **unused and vestigial** — 052's one-folder-per-connection design moved to `integration_drive_folders` below, and dropping the columns would be a second destructive change for no benefit.

**`integration_drive_folders`** (new) — the unit of sync; many rows per connection. `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `connection_id` UUID NOT NULL, composite FK → `integration_drive_connections (org_id, id)` ON DELETE CASCADE · `purpose` TEXT NOT NULL, CHECK IN (`VENDOR_BILL`,`BANK_STATEMENT`) · `folder_id` TEXT NOT NULL, CHECK matches Drive's id shape · `folder_name` TEXT NOT NULL, `<= 255` chars · `is_active` BOOLEAN NOT NULL DEFAULT `true` · `ledger_account_id` UUID NULL (see below) · `date_format` TEXT NULL, CHECK IN (`ISO`,`DMY`,`MDY`) · `column_map` JSONB NULL · `drive_cursor` TIMESTAMPTZ NULL — the `modifiedTime` high-water mark the next sync's `files.list` call filters on · `last_synced_at`/`last_sync_error` · `created_by` FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at`, bumped by `set_updated_at`. `ux_integration_drive_folders_org_id_id` — the composite target `integration_drive_files` references. `ux_integration_drive_folders_folder` — `UNIQUE (org_id, folder_id, purpose)`, letting one Drive folder be watched for two different purposes but never twice for the same one. `chk_integration_drive_folders_purpose_payload` — the discriminated pairing: `VENDOR_BILL` ⇒ `ledger_account_id`/`date_format`/`column_map` all NULL; `BANK_STATEMENT` ⇒ `ledger_account_id` and `date_format` both NOT NULL.

**`ledger_account_id` carries no `REFERENCES accounts`** — the identical rule-16-over-rule-8 ruling `ai_model_calls.entity_id` and `document_links.entity_id` already carry: a platform table must not hard-wire an FK into one app's schema. Validity is checked through LedgerCore's own `accountService.getAccountById`, the seam, never a direct query against `accounts`.

**`integration_drive_files`** (renamed from `ap_flow_drive_files`) gains `folder_id` UUID NULL, composite FK → `integration_drive_folders (org_id, id)` ON DELETE CASCADE · `result_app` TEXT NULL, CHECK IN (`ap-flow`,`ledger-core`) · `result_entity_id` UUID NULL · `chk_integration_drive_files_result` — `(result_app IS NULL) = (result_entity_id IS NULL)`. The generic `(result_app, result_entity_id)` pair is the `source_type`/`source_id` convention rule 16 already names, replacing the real FK 052 had into `ap_flow_documents` now that a file can land in either of two apps' tables — see the Phase 19.2 section above for the `ON DELETE SET NULL` capability this trades away. `ap_flow_document_id` stays, vestigial, backfilled from existing rows.

A backfill inserts one `VENDOR_BILL` folder per connection that had a `folder_id` under the old one-folder design, and updates existing file rows to point at it with `result_app = 'ap-flow'`.

See [api.md](api.md#integrations--apiv1integrationsdrive--phase-193) for the routes, [study/security-auth/oauth2-pkce-and-secrets-at-rest.md](../study/security-auth/oauth2-pkce-and-secrets-at-rest.md), and [study/security-auth/service-accounts-and-jwt-bearer.md](../study/security-auth/service-accounts-and-jwt-bearer.md).

## Phase 19.4 — AP-Flow duplicate-content capture — applied

Three migrations. `054_ap-flow_duplicate_capture.sql` does the real work; `055` and `056` each correct a mistake in the one before, caught by that phase's own tests.

**`054`** drops `ux_ap_flow_documents_document UNIQUE (org_id, document_id)` — a second AP-Flow registration of the same vault document (the Document Vault is content-addressed by SHA-256, so a renamed re-upload or a second Drive file with identical bytes resolves to the same vault row) is now schema-legal, where it was previously impossible. Adds `duplicate_of_id` UUID NULL, composite self-FK `(org_id, duplicate_of_id) → ap_flow_documents (org_id, id)` ON DELETE SET NULL (`duplicate_of_id`) — the same PG15+ column-list form 052 used, nulling only this column, never `org_id`. Widens the `status` CHECK to add `DUPLICATE`.

**`055`** replaces `054`'s original CHECK — `(status = 'DUPLICATE') = (duplicate_of_id IS NOT NULL)`, a biconditional — with a one-directional form, `status <> 'DUPLICATE' OR duplicate_of_id IS NOT NULL`. The biconditional made it impossible for a document to move `DUPLICATE -> PENDING` (a human confirming it was never actually a duplicate) while *keeping* `duplicate_of_id` as history: the CHECK forced clearing it in the same statement. Caught by `documents.test.ts`'s own new test for that exact transition.

**`056`** drops the CHECK entirely. `054`'s FK has `ON DELETE SET NULL (duplicate_of_id)`, which fires if the row a `DUPLICATE` points at is ever deleted — nulling `duplicate_of_id` while leaving `status` untouched. Postgres re-validates every CHECK against the row a cascade action produces, so a still-`DUPLICATE` row with a freshly-nulled pointer violated even `055`'s relaxed constraint, on an action nothing but the FK itself performed. There is in fact no `DELETE` route or query anywhere on `ap_flow_documents` today, so this FK action is defensive plumbing for a case the application never triggers — the real invariant, "a `DUPLICATE` row is never *created* without a target," is fully guaranteed by the single function that ever sets this status (`captureDocumentService.createApFlowDocument`), not by a database CHECK. See [study/postgresql/migrations-and-schema-evolution.md](../study/postgresql/migrations-and-schema-evolution.md) and [study/architecture/document-lifecycle-fsm.md](../study/architecture/document-lifecycle-fsm.md).

See [api.md](api.md#ap-flow--apiv1ap-flow--phases-1011-19-191-192) for the routes.

## Phase 29 — five apps retired (platform) — applied

Migrations `033`–`047` originally built 20 tables across five apps — FP&A Engine (Phase 12), ForecasterPro (Phase 13), UnitEcon (Phase 14), BoardDeck Automator (Phase 15) and TaxGuard AI (Phase 16) — plus the Phase 18 sandbox dataset. All five apps and the sandbox were removed from the suite on 2026-09-23 (Phase 29); see [roadmap.md § Phase 29 — as delivered](roadmap.md#phase-29-as-delivered) for what was removed and why.

**`033`–`047` remain on disk, unedited, and still checksum-verified on every `npm run migrate`.** Rule 13 makes an applied migration immutable, and `migrate.ts` rejects any gap in the sequential prefix — deleting or renumbering them was rejected for exactly that reason. They now describe tables that no longer exist:

- `033_fpa-engine_models.sql`, `034_fpa-engine_assumptions.sql` — retired `fpa_models`, `fpa_scenarios`, `fpa_assumptions`
- `035_forecaster_plans.sql` – `039_forecaster_budgets.sql` — retired `forecaster_plans`, `forecaster_drivers`, `forecaster_driver_values`, `forecaster_headcount_roles`, `forecaster_forecast_lines`, `forecaster_budget_versions`, `forecaster_budget_lines`
- `040_unitecon_settings.sql`, `041_unitecon_product_lines.sql` — retired `unitecon_settings`, `unitecon_acquisition_accounts`, `unitecon_product_lines`
- `042_boarddeck_close_runs.sql`, `043_boarddeck_decks.sql` — retired `boarddeck_close_runs`, `boarddeck_close_checks`, `boarddeck_decks`
- `044_taxguard_pgvector.sql` – `046_taxguard_questions.sql` — the `vector` extension, retired `taxguard_corpus_documents`, `taxguard_chunks`, `taxguard_questions`
- `047_platform_sandbox_datasets.sql` — retired `sandbox_datasets`

**`068_platform_drop_retired_apps.sql`** drops all 20 tables above (children before parents; `CASCADE` is belt-and-braces — no surviving table ever carried a `REFERENCES` into one of them), drops the `vector` extension, and deletes any `organization_apps` / `onboarding_states` / `document_links` row naming a retired slug. `audit_logs`, `ai_model_calls`, `outbox_events` and `webhook_deliveries` rows carrying a retired `app_slug` are deliberately **left in place** — they record what genuinely happened, and rewriting them would falsify the Phase 5 CDC trail.

**A fresh database still creates these 20 tables and immediately drops them.** `033`–`047` run first in migration order regardless, which is why `docker-compose.yml` keeps the `pgvector/pgvector:pg16` image even though nothing uses the extension any more — `044` still calls `CREATE EXTENSION vector` on a from-scratch migrate. Slightly slower first migrate; no correctness impact.

See [roadmap.md § Phase 29 — as delivered](roadmap.md#phase-29-as-delivered) and [api.md](api.md) (the routes these apps once exposed are gone from that file too).

## Phase 24 — payment terms, item catalogue, party import (LedgerCore) — applied

`058_ledger-core_payment_terms.sql` adds `payment_terms` and backfills the seven standard terms for every pre-existing organization; `059_ledger-core_items.sql` adds `items`; `060_ledger-core_reference_data_cascade.sql` fixes `058`/`059`'s `org_id` FK mode from `RESTRICT` to `CASCADE` (see below — a real bug caught by `guardrail-review` mid-build, corrected forward rather than by editing the applied migrations); `061_ledger-core_line_items.sql` adds `item_id` to `invoice_lines`/`bill_lines`; `062_ledger-core_party_import.sql` widens `migration_imports.kind` and adds seven `party_*` columns to `migration_import_rows`. Five migrations.

**`payment_terms`** — `id` UUID PK · `org_id` FK → `organizations` **ON DELETE CASCADE** (see the `060` note below) · `code` TEXT NOT NULL, CHECK `~ '^[A-Z0-9_]{2,30}$'` · `name` TEXT NOT NULL, non-blank, `<= 60` chars · `net_days` SMALLINT NOT NULL, `0`–`365` · `is_system` BOOLEAN NOT NULL DEFAULT `false` — `true` for the seven standards; a system term's `code`/`name`/`net_days` are frozen by the service (never by a CHECK — there is no database-level way to say "these columns are immutable only when this flag is true") · `is_active` BOOLEAN NOT NULL DEFAULT `true` · `created_by` FK → `users` ON DELETE RESTRICT, **nullable** — `NULL` means "seeded by the platform" (the `058` backfill has no acting user) · `created_at`/`updated_at`. `ux_payment_terms_org_id_id` — `UNIQUE (org_id, id)`, the standard composite-FK-target convention. `ux_payment_terms_org_code` — `UNIQUE (org_id, code)`. Indexed on `(org_id, is_active, net_days)` and on `created_by`. Every new organization gets the seven standards (`DUE_ON_RECEIPT`, `NET_7`, `NET_15`, `NET_30`, `NET_45`, `NET_60`, `NET_90`) seeded by `paymentTermService.seedStandardPaymentTerms` on the same transaction `authService.register` already opens for the default chart of accounts; `058`'s own `INSERT ... ON CONFLICT (org_id, code) DO NOTHING` backfills every organization that existed before this phase. No immutability trigger and no status FSM — a term is retired with `is_active = false`, matching `accounts`/`customers`/`vendors`, never deleted.

**`invoices.payment_terms_code`** / **`bills.payment_terms_code`** — nullable `TEXT`, added by `058`. **Deliberately not a foreign key.** A posted invoice or bill is immutable (rule 6); a `payment_terms` FK would let renaming or deactivating a term reach back into a document that already posted. The column is a snapshot of the term's code at write time, exactly like the pre-existing `payment_terms` column is a snapshot of its *label* — the two travel together, written once by `invoiceService.resolveInvoiceDueDate` / `billService.resolveBillDueDate`.

**`items`** — `id` UUID PK · `org_id` FK → `organizations` **ON DELETE CASCADE** · `code` TEXT NOT NULL, non-blank, `<= 40` chars · `name` TEXT NOT NULL, non-blank, `<= 200` chars · `description` TEXT NULL, `<= 500` chars · `kind` TEXT NOT NULL, CHECK IN (`SERVICE`, `GOODS`) · `sale_price_cents` / `purchase_price_cents` BIGINT NULL, each `0`–`10^12` when present · `revenue_account_id` / `expense_account_id` UUID NULL, each a composite FK → `accounts (org_id, id)` ON DELETE RESTRICT — satisfied when `NULL`, the same idiom `invoices.journal_entry_id` uses · `sale_tax_rate_bp` / `purchase_tax_rate_bp` INTEGER NOT NULL DEFAULT `0`, each `0`–`10000` · `is_active` BOOLEAN NOT NULL DEFAULT `true` · `created_by` FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at`. `ux_items_org_id_id` — `UNIQUE (org_id, id)`. `ux_items_org_code` — `UNIQUE (org_id, code)`. Indexed on `(org_id, is_active, code)` and on both account FKs and `created_by`. **A catalogue, not inventory** — no on-hand quantity, no stock movement, no COGS posting, no inventory valuation; those are a subsystem of their own and are deliberately not built. `code` and `kind` are frozen once created, by the service, matching `accounts` refusing `code`/`type` on a live account. No immutability trigger, no status FSM — retired with `is_active = false`.

**`060_ledger-core_reference_data_cascade.sql`** exists only to correct `058`/`059`: both originally declared `org_id ... ON DELETE RESTRICT`, copying the pattern from tables that hold posted documents (`invoices`, `bills`, `journal_entries`, `fiscal_periods`, `payments`, `migration_imports`, `fx_revaluations`) — RESTRICT there exists so a still-posted document cannot have its organization pulled out from under it. `payment_terms` and `items` are reference/lookup data, the same kind as `accounts`/`customers`/`vendors`, all of which use `CASCADE`. The mistake broke `DELETE FROM organizations` everywhere else in the codebase relies on cascade to clean up. `058`/`059` were already applied, so per rule 13 they were not edited — `060` drops and re-adds each FK as `CASCADE` instead.

**`invoice_lines.item_id`** / **`bill_lines.item_id`** — nullable `UUID`, added by `061`, each a composite FK → `items (org_id, id)` ON DELETE RESTRICT, each indexed. Nullable on purpose: every pre-Phase-20 line has no item, and a free-typed line (no catalogue entry picked) must stay legal forever. **Picking an item copies its defaults into the line at write time** — `description`, `unit_price_cents`, the account, `tax_rate_bp` are still whatever the request sent; the line never reads through to the item afterward. `item_id` is therefore a record of what was picked, not a live reference the line's values depend on.

**`migration_imports.kind`** widens from `('CHART_OF_ACCOUNTS', 'OPENING_BALANCES')` to add `CUSTOMERS` and `VENDORS`, via `062` replacing `029`'s inline (and therefore Postgres-auto-named) `CHECK` with an explicitly named `chk_migration_imports_kind` — widening a `CHECK` from a later migration rather than editing `029` (rule 13); no existing row can violate the larger set, so this is non-destructive. `migration_import_rows` gains seven nullable `TEXT` columns for the two new kinds — `party_name`, `party_email`, `party_phone`, `party_address`, `party_tax_number`, `party_payment_terms`, `party_notes` — the same shape as the existing `account_code`/`account_name`/… columns: no `FK`, staged free text validated only by `partyImportService.validateRows` before a row can move to `VALID`. This is an **extension of the Phase 9b staged importer**, not a second import pipeline — `migration_imports`/`migration_import_rows` themselves are unchanged in shape beyond these additive columns; see [Phase 9b](#phase-9b--chart--opening-balance-import-ledger-core--applied) above for the two-table design this reuses.

**Commit is a merge-or-create, never an overwrite.** `partyImportService.commitOnClient` matches a staged row to an existing `customers`/`vendors` row by lowercased email first, then by lowercased name; a match fills only the columns that are currently `NULL` on the existing row, so an import can never clobber data already in the system. `customers` has no `payment_terms` column, so an imported customer's payment-terms text is appended to `notes` on its own line (`"Payment terms: <value>"`) rather than dropped; `vendors` maps it onto its own `payment_terms` column directly.

See [api.md](api.md#ledgercore--apiv1ledger-core) for the routes and [accounting.md](accounting.md) for the full feature description and gaps.

## Phase 25 — customer & vendor accounts (LedgerCore) — no migration

**No schema change.** A customer's or vendor's account is derived on read: a control-account `ledger_lines` row belongs to a party when its `journal_entry_id` equals the `journal_entry_id` or `void_journal_entry_id` of that party's `invoices`/`bills`/`payments` row. All six are existing columns with composite `(org_id, …)` FKs into `journal_entries`, and each already has its own index (`idx_invoices_journal_entry`, `idx_invoices_void_journal_entry`, `idx_payments_journal_entry`, `idx_payments_void_journal_entry` and the `bills` equivalents). `ledger_lines` deliberately carries **no** `customer_id`/`vendor_id`. Instead of party-tagging, manual and bank-line journals are refused on the control accounts at the service layer (`journalService.assertNotControlAccountsOnClient`); there is no database trigger for this rule, because the document posting path must still write to those accounts. See [roadmap.md § Phase 25](roadmap.md#phase-25-as-delivered).

## Phase 26 — credit & debit notes (LedgerCore) — applied

`063_ledger-core_credit_debit_notes.sql`, one migration. A **credit note** reduces what a customer owes on an `ISSUED` invoice; a **debit note** reduces what we owe on a `POSTED` bill. Both reference their original, copy its party/currency/`fx_rate`, and settle it through an insert-only allocation table — the same shape as `payment_allocations`.

**`credit_notes`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE RESTRICT (a posted document, like `invoices`) · `customer_id` composite FK → `customers (org_id, id)` RESTRICT · `invoice_id` **NOT NULL** composite FK → `invoices (org_id, id)` RESTRICT · `credit_note_number` TEXT NULL until issue, `UNIQUE (org_id, credit_note_number)` · `status` CHECK IN (`DRAFT`, `ISSUED`, `VOID`) — exactly `NOTE_TRANSITIONS` in `types/accounting.ts` · `reason_code` CHECK IN (`RETURN`, `PRICE_ADJUSTMENT`, `DISCOUNT`, `DAMAGED`, `OTHER`) · `reason` ≤ 500 · `issue_date` · `currency_code` CHAR(3) · `fx_rate` NUMERIC(18,8) (`> 0`, `<= 1,000,000`; copied from the invoice) · `customer_name_snapshot`/`_address_snapshot`/`_tax_number_snapshot` (the invoice's own snapshot) · `notes` · `subtotal_cents`/`tax_cents`/`total_cents` BIGINT `>= 0`, `chk_credit_notes_total` (`total = subtotal + tax`) · `base_subtotal_cents`/`base_tax_cents`/`base_total_cents` BIGINT · `journal_entry_id`/`void_journal_entry_id` composite FKs → `journal_entries` RESTRICT · `issued_at`/`voided_at` · `created_by` FK → `users` RESTRICT · `created_at`/`updated_at`. `chk_credit_notes_issued_complete`: an `ISSUED` row has a number, a journal entry, `issued_at`, and `total_cents > 0`. Indexed on `(org_id, status, issue_date DESC)` and every FK column.

**`credit_note_lines`** — the `invoice_lines` shape (`line_number`, `description`, `quantity_milli`, `unit_price_cents`, `revenue_account_id` composite FK → `accounts` RESTRICT, `tax_rate_bp`, `net_cents`, `tax_cents`), parent FK `ON DELETE CASCADE` (a draft's lines go with it), `UNIQUE (credit_note_id, line_number)`. No `item_id`.

**`credit_note_allocations`** — `id` · `org_id` · `credit_note_id` composite FK RESTRICT · `invoice_id` composite FK RESTRICT (the original, or any other invoice of the same customer it was applied to) · `amount_cents` BIGINT `> 0` · `base_amount_cents` BIGINT `>= 0` (at the note's rate) · `allocation_date` DATE · `created_by` FK → `users` RESTRICT · `created_at`. No `UNIQUE` on `(note, invoice)` — a note may be applied to the same invoice in two steps.

**`debit_notes`**, **`debit_note_lines`**, **`debit_note_allocations`** — the exact mirror with `vendor_id` → `vendors`, `bill_id` → `bills`, `debit_note_number`, `vendor_*_snapshot`, `expense_account_id` on lines, and one extra column: `debit_notes.vendor_credit_reference` TEXT ≤ 100 (the vendor's own credit-note number).

**`ledger_invoice_settings`** gains `credit_note_prefix` (default `'CN-'`), `credit_note_next_number`, `debit_note_prefix` (default `'DN-'`), `debit_note_next_number` — the same counter-row-with-lock pattern as the invoice number, allocated inside the issuing transaction; padding reuses `number_padding`.

**Triggers.**
- `reject_issued_note_mutation()` on both note tables (`trg_credit_notes_immutable`, `trg_debit_notes_immutable`) — `09`'s rule: DRAFT is editable/deletable, otherwise only `ISSUED -> VOID` touching `status`/`voided_at`/`void_journal_entry_id` (the `to_jsonb` row-diff). `0A000`.
- `reject_non_draft_note_line_mutation()` on both line tables — lines change only while the parent is DRAFT. `0A000`.
- `reject_note_allocation_mutation()` — allocations are insert-only, always. `0A000`. Voiding a note leaves them in place; they stop counting because every settlement read filters `status = 'ISSUED'`.
- `assert_note_allocation_within_limits()` — deferred constraint trigger on both allocation tables: a note never applies more than its total, and payments + applied notes never exceed the document total. `P0001`.
- `assert_notes_within_original()` — deferred constraint trigger on both note tables: Σ `ISSUED` notes against one original ≤ its total. `P0001`. The service additionally holds the original's row lock while it sums, which is what makes the check race-free.
- `assert_no_overallocation()` — **replaced** by `063` (`CREATE OR REPLACE`, the trigger from `014` is untouched): a payment allocation must now fit inside total − payments − applied notes.
- `set_updated_at()` and `audit_row_change('ledger-core')` on both note tables (parents only).

**Settlement is still derived, never stored** — now from two sources: `amount due = total − Σ POSTED payment allocations − Σ ISSUED note allocations`, defined once in `services/accounting/settlementSql.ts`. An ISSUED note's *unapplied* remainder is a negative open item in AR/AP aging and party open items.

## Phase 27 — organization app selection (platform) — applied

`064_platform_organization_apps.sql` adds `organization_apps`: one row per app an organization has enabled, no row = not enabled.

**`organization_apps`** — `id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `app_slug` TEXT NOT NULL (non-blank CHECK, `<= 40` chars) · `enabled_by` UUID nullable FK → `users` ON DELETE RESTRICT · `enabled_at` TIMESTAMPTZ NOT NULL DEFAULT `now()`. `ux_organization_apps_org_app` — `UNIQUE (org_id, app_slug)`. `idx_organization_apps_org` on `org_id`, `idx_organization_apps_enabled_by` on `enabled_by`. `trg_organization_apps_audit` (`audit_row_change('platform')`), so every enable and removal lands in `audit_logs`.

`app_slug` has no `REFERENCES` and no enumerated CHECK — validated against `config/apps.ts` in `organizationAppService`, the same call 017 and 027 made. Rows are inserted or deleted, never updated, so there is no `updated_at`; a saved selection replaces the set (delete the apps dropped, `INSERT … ON CONFLICT DO NOTHING` the apps added, so a kept app keeps its first `enabled_at`). `enabled_by` is nullable **only** for backfilled rows; every service write sets it.

**Backfill.** Every organization that existed at migration time gets all seven apps (a hard-coded snapshot of `config/apps.ts` at 2026-09-22) and a `COMPLETED` `onboarding_states` row for `app_slug = 'platform'` — the suite-level step the app picker completes — so no existing user is sent to `/welcome`. Both inserts are `ON CONFLICT DO NOTHING`.

**Dropped in Phase 33 (migration `073`).** One product, no app selection. **Visibility, not access control.** No app route ever consulted this table — see [roadmap.md § Phase 27](roadmap.md#phase-27-as-delivered).

---

## Phase 28 — StockLedger (platform-independent app) — applied

`065_stock_setup.sql`, `066_stock_items.sql`, `067_stock_movements.sql` — 12 tables across three migrations. Full spec: [inventory.md](inventory.md).

**065 — setup & catalogue:**

**`stock_settings`** — `org_id` UUID **PK**, FK → `organizations` ON DELETE CASCADE (one row per org, not a surrogate `id`) · `industry_profile` TEXT NOT NULL, CHECK IN the 10 profile keys · `created_by` FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at`. No row until `POST /stock/setup`.

**`stock_uoms`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `code` TEXT NOT NULL, CHECK `^[A-Z0-9]{1,10}$` · `name` · `decimal_places` SMALLINT NOT NULL, CHECK `0..3` · `is_active` · `created_by`/`created_at`/`updated_at`. `ux_stock_uoms_org_code` — `UNIQUE (org_id, code)`.

**`stock_categories`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `parent_id` UUID, composite FK → `stock_categories (org_id, id)` ON DELETE RESTRICT (a category with children can't be deleted out from under them) · `code`/`name` · `item_type` TEXT NOT NULL, CHECK IN 9 values (`RAW_MATERIAL`…`PROPERTY_UNIT`) · `default_tracking` TEXT NOT NULL, CHECK IN (`QUANTITY`,`LOT`,`SERIAL`) · `default_uom_id` UUID, composite FK → `stock_uoms` ON DELETE RESTRICT · `is_active`/`created_by`/`created_at`/`updated_at`. **Frozen once created** (service layer): `code`, `parent_id`, `item_type`, `default_tracking` never change — which is what makes a parent-cycle check structurally unnecessary, not merely untested. Up to 3 levels deep, enforced at insert time by a recursive-CTE depth count.

**`stock_attribute_definitions`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `category_id` UUID NOT NULL, composite FK → `stock_categories` ON DELETE CASCADE · `applies_to` TEXT NOT NULL, CHECK IN (`ITEM`,`SERIAL`) · `key` TEXT NOT NULL, CHECK `^[a-z][a-z0-9_]{0,39}$` · `label`/`data_type` (CHECK IN `TEXT`,`NUMBER`,`DATE`,`BOOLEAN`,`SELECT`) · `options` JSONB (array, 1–50 entries, **only** when `data_type = 'SELECT'`, CHECK-enforced) · `decimal_places` SMALLINT (**only** when `data_type = 'NUMBER'`, CHECK-enforced) · `is_required`/`sort_order`/`is_active`/`created_by`/`created_at`/`updated_at`. `ux_stock_attr_defs_key` — `UNIQUE (org_id, category_id, applies_to, key)`. Definitions are relational and DB-checked; **values** are JSONB on the item/serial row, checked only for `jsonb_typeof = 'object'` — the real per-value validation is `utils/stockAttributes.ts`, service layer. See [study/postgresql/jsonb-user-defined-attributes.md](../study/postgresql/jsonb-user-defined-attributes.md).

**`stock_code_schemes`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `name`/`pattern` (`<= 60` chars, `utils/stockCodePattern.ts`'s grammar) · `is_default`/`is_active`/`created_by`/`created_at`/`updated_at`. `ux_stock_code_schemes_org_name` — `UNIQUE (org_id, name)`. `ck_stock_code_schemes_default_active` — a default scheme can't also be inactive. `ux_stock_code_schemes_one_default` — a **partial unique index** (`WHERE is_default`), at most one default per org — see [study/postgresql/partial-unique-indexes.md](../study/postgresql/partial-unique-indexes.md).

**`stock_code_counters`** — `org_id`/`scheme_id`/`scope_key` **composite PK**, no surrogate `id` · `next_value` BIGINT NOT NULL, CHECK `>= 1`. `scope_key` is the pattern rendered with `{SEQ:n}` replaced by `#` — one counter per distinct rendered scope (category × year, for a pattern keyed on both), not one per org. No `updated_at`, no audit trigger — a counter bump is not a business event. See [study/postgresql/gapless-numbering-and-counters.md](../study/postgresql/gapless-numbering-and-counters.md).

**`stock_locations`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `parent_id` UUID, composite FK → `stock_locations` ON DELETE RESTRICT · `code`/`name` · `kind` TEXT NOT NULL, CHECK IN (`WAREHOUSE`,`STORE`,`SITE`,`ZONE`,`BIN`) · `is_active`/`created_by`/`created_at`/`updated_at`. `ck_stock_locations_top_level` — a `WAREHOUSE`/`STORE`/`SITE` has no parent; a `ZONE`/`BIN` always has one. Up to 4 levels, recursive-CTE path display.

**066 — items:**

**`stock_items`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE RESTRICT · `code` TEXT NOT NULL, CHECK `^[A-Z0-9][A-Z0-9\-_/.]{0,39}$` · `name`/`description` · `category_id`/`uom_id` UUID NOT NULL, composite FKs ON DELETE RESTRICT · `item_type` (the same 9-value CHECK as `stock_categories`) · `tracking` TEXT NOT NULL, CHECK IN (`QUANTITY`,`LOT`,`SERIAL`) · `code_scheme_id` UUID nullable, composite FK ON DELETE RESTRICT · `barcode` TEXT nullable, CHECK matches an 8/12/13/14-digit GTIN shape (checksum verified in the service, `utils/gtin.ts`) · `attributes` JSONB NOT NULL DEFAULT `{}`, CHECK `jsonb_typeof = 'object'` · `reorder_point_milli` BIGINT nullable · `is_active`/`created_by`/`created_at`/`updated_at`. `ux_stock_items_org_code` — `UNIQUE (org_id, code)`. `ux_stock_items_org_barcode` — a **partial unique index** (`WHERE barcode IS NOT NULL`). `idx_stock_items_attributes` — `GIN (attributes jsonb_path_ops)`. `code` and `tracking` are frozen once created (service layer).

**067 — lots, serials, movements, balances:**

**`stock_lots`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE RESTRICT · `item_id` UUID NOT NULL, composite FK → `stock_items` ON DELETE RESTRICT · `lot_number`/`manufactured_on`/`expires_on`/`created_by`/`created_at`. `ux_stock_lots_item_number` — `UNIQUE (org_id, item_id, lot_number)`. `ck_stock_lots_dates` — expiry can't precede manufacture.

**`stock_serials`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE RESTRICT · `item_id` UUID NOT NULL, composite FK ON DELETE RESTRICT · `serial_number` · `status` TEXT NOT NULL, CHECK IN (`AVAILABLE`,`ON_HOLD`,`BOOKED`,`ISSUED`) · `location_id` UUID nullable, composite FK ON DELETE RESTRICT · `cost_cents` BIGINT NOT NULL · `status_note`/`attributes` (same JSONB shape as items) · `created_by`/`created_at`/`updated_at`. `ux_stock_serials_item_number` — `UNIQUE (org_id, item_id, serial_number)`. `ck_stock_serials_location` — `(status = 'ISSUED') = (location_id IS NULL)`: an `ISSUED` serial structurally has no location, every other status has one. The one exported FSM transition table for this column is `types/inventory.ts`'s `STOCK_SERIAL_TRANSITIONS` — see [study/typescript/const-assertions-and-satisfies.md](../study/typescript/const-assertions-and-satisfies.md) for why it's a plain `Record` annotation, not `as const satisfies`.

**`stock_movements`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE RESTRICT · `movement_group_id` UUID NOT NULL (shared by a transfer's OUT+IN pair) · `movement_type` TEXT NOT NULL, CHECK IN (`RECEIPT`,`ISSUE`,`TRANSFER_OUT`,`TRANSFER_IN`,`ADJUSTMENT_IN`,`ADJUSTMENT_OUT`) · `item_id`/`location_id` UUID NOT NULL, composite FKs ON DELETE RESTRICT · `lot_id`/`serial_id` UUID nullable, composite FKs ON DELETE RESTRICT · `quantity_milli` BIGINT NOT NULL, CHECK nonzero and `abs <= 1e9` · `value_cents` BIGINT NOT NULL · `reference`/`reason`/`occurred_on`/`created_by`/`created_at`. `ck_stock_movements_sign` — inbound types are positive quantity/non-negative value, outbound types are negative/non-positive. `ck_stock_movements_lot_xor_serial` — never both. `ck_stock_movements_serial_unit` — a serial movement is always exactly 1 unit (`abs(quantity_milli) = 1000`). **Append-only** — `trg_stock_movements_immutable` (`BEFORE UPDATE OR DELETE`) rejects any mutation, the identical posture `journal_entries`/`ledger_lines` have (migration 004, rule 6) — a correction is a new movement, never an edit.

**`stock_balances`** — `id` UUID PK · `org_id`/`item_id`/`location_id` UUID NOT NULL, composite FKs ON DELETE RESTRICT · `lot_id` UUID nullable, composite FK ON DELETE RESTRICT · `quantity_milli` BIGINT NOT NULL DEFAULT `0`, CHECK `>= 0` (negative stock refused in the DB too) · `value_cents` BIGINT NOT NULL DEFAULT `0`, CHECK `>= 0` · `updated_at`. `ux_stock_balances_key` — `UNIQUE NULLS NOT DISTINCT (org_id, item_id, location_id, lot_id)` (PG 15+): a `NULL` `lot_id` collides with another `NULL` `lot_id` for the same item/location, so a `QUANTITY`-tracked item gets exactly one row per location rather than unlimited "no lot" rows. `ck_stock_balances_empty_has_no_value` — zero quantity implies zero value. **Derived cache, not source of truth** — maintained in the same transaction as each movement (`movementService.ts`), independently reconciled against Σ `stock_movements` by `db/integrity.ts`'s `stock_balances_match_movements`, the 5th platform integrity check. No audit trigger — its truth is the movement rows; auditing a cache row on every movement would double every audit entry for no informational gain. See [study/postgresql/partial-unique-indexes.md](../study/postgresql/partial-unique-indexes.md) and [study/postgresql/transactions-isolation-pooling.md](../study/postgresql/transactions-isolation-pooling.md) (deterministic lock ordering across balance rows).

**Every `*_id` FK is composite** (`org_id`, `id`) against the referenced table's own composite unique target, so one organization's row can never reference another's (the same pattern every phase since 3.5 uses — see [composite-foreign-keys-for-tenancy.md](../study/postgresql/composite-foreign-keys-for-tenancy.md)). **No table in this phase posts to or reads from the general ledger** — StockLedger `requires: []` in `config/apps.ts`, the one app in the suite with no `source_type`/`source_id` hook and no cross-app `REFERENCES`.

See [api.md](api.md#stockledger--apiv1stock--phase-28) for the routes and [inventory.md](inventory.md) for the industry profiles, code-pattern grammar, attribute rules, tracking/valuation rulings, the serial FSM, the lock-order rule and the QR payload.

---

## Phase 30 — organization profile & invoice templates (platform + LedgerCore) — applied

A direct feature request. Migrations `069` (platform) and `070` (LedgerCore). See [roadmap.md § Phase 30, as delivered](roadmap.md#phase-30-as-delivered).

**`069_platform_organization_profile.sql` — `organization_profiles`** — one row per organization, keyed by `org_id` itself (same shape as `ledger_settings`). 22 columns: `org_id` UUID **PRIMARY KEY** FK → `organizations` ON DELETE CASCADE · `legal_name` TEXT NULL, CHECK non-blank when present, `<= 200` chars · `industry` TEXT NULL, `<= 120` chars, free text (no fixed picker) · `street_address_1`/`street_address_2` TEXT NULL, `<= 200` · `city`/`region` TEXT NULL, `<= 120` · `postal_code` TEXT NULL, `<= 32` · `country_code` CHAR(2) NULL, CHECK `~ '^[A-Z]{2}$'` · `postal_same_as_street` BOOLEAN NOT NULL DEFAULT `true` · `postal_address_1`/`postal_address_2`/`postal_city`/`postal_region`/`postal_postal_code`/`postal_country_code` — the mailing-address mirror of the six street-address columns above, same constraints · `phone` TEXT NULL, `<= 40` · `contact_email` TEXT NULL, `<= 254`, CHECK `contact_email = lower(contact_email)` (rule 9) · `website` TEXT NULL, `<= 200` · `logo_document_id` UUID NULL · `created_at`/`updated_at`.

The absence of a row means "never filled in," not `404` — `organizationProfileService.getProfile` returns `PROFILE_DEFAULTS` (every field `null` except `postalSameAsStreet: true`) with `configured: false`, the same convention `getInvoiceSettings` and `getSettings` already use.

**The logo FK is composite:** `fk_organization_profiles_logo_document` — `FOREIGN KEY (org_id, logo_document_id) REFERENCES documents (org_id, id) ON DELETE RESTRICT`, targeting `ux_documents_org_id_id` from migration `030`, so one tenant's profile can never point at another tenant's uploaded document (rule 1, rule 8). `ON DELETE RESTRICT` rather than `SET NULL`: a composite `SET NULL` on this FK would null `org_id`, which is this table's own primary key — restricting the delete is the only sound choice. Indexed on `logo_document_id` (`idx_organization_profiles_logo_document`).

**One-time, idempotent backfill:** `legal_name` and `industry` move here from `ledger_settings` (`INSERT ... SELECT ... ON CONFLICT (org_id) DO NOTHING`) for every organization that had either set. **`ledger_settings.legal_name` and `ledger_settings.industry` stay on disk, unedited, per rule 13** — superseded, no longer read or written by any service from this phase onward. `settingsService.ts`'s `SETTINGS_SELECT` now `LEFT JOIN`s `organization_profiles` and reads `legal_name`/`industry` from there instead, keeping `LedgerSettings`' public JSON shape unchanged.

**`070_ledger-core_invoice_template.sql` — nine columns on `ledger_invoice_settings`** (migration `007`): `template_id` TEXT NOT NULL DEFAULT `'classic'` · `document_title` TEXT NOT NULL DEFAULT `'INVOICE'` · `font_family` TEXT NOT NULL DEFAULT `'sans'` · `density` TEXT NOT NULL DEFAULT `'comfortable'` · `show_logo` / `show_org_address` / `show_payment_terms` / `show_due_date` BOOLEAN NOT NULL DEFAULT `true` · `bank_details` TEXT NULL. Five CHECK constraints, each in its own `pg_constraint`-guarded `DO` block (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`): `ck_invoice_settings_template_id` — `template_id IN ('classic', 'modern', 'compact')` · `ck_invoice_settings_font_family` — `font_family IN ('sans', 'serif')` · `ck_invoice_settings_density` — `density IN ('comfortable', 'compact')` · `ck_invoice_settings_document_title` — non-blank, `<= 24` chars · `ck_invoice_settings_bank_details` — `<= 500` chars when present.

**Templates are a closed set of code-defined layouts (`classic`/`modern`/`compact`), never user-authored markup** — the CHECK is what makes rendering by id safe, since no request value ever reaches the DOM as markup (a template language would be a stored-XSS surface). The `IN` lists here and `INVOICE_TEMPLATE_IDS`/`INVOICE_FONT_FAMILIES`/`INVOICE_DENSITIES` in `server/src/config/constants.ts` must be changed together.

**No new endpoints for the Financial, Chart of accounts or Conversion balances settings tabs** — all three are client-only pages over routes that already existed before this phase (`PATCH /settings`, `listAccountTree`/`createAccount`/`updateAccount`, and the staged migration importer's `POST /migration-imports` with `kind: 'OPENING_BALANCES'`).

See [api.md](api.md#organizations--apiv1organizations) and [api.md](api.md#invoice-settings--apiv1ledger-coresettingsinvoicing--phase-38) for the routes and [accounting.md](accounting.md) for the full feature description and gaps.

---

## Phase 32 — one product master and inventory posting (LedgerCore + StockLedger) — applied

A direct feature request. Migrations `071` (LedgerCore) and `072` (StockLedger). See [roadmap.md § Phase 32, as delivered](roadmap.md#phase-32-as-delivered). Every statement is idempotent; every `ADD CONSTRAINT` sits in a `pg_constraint`-guarded `DO` block.

**`071_ledger-core_item_types_and_inventory_accounts.sql`**
- `items`: `item_type` TEXT NOT NULL (backfilled `SERVICE`→`SERVICE`, `GOODS`→`NON_INVENTORY`, then its default dropped, so a raw insert must name it) · `asset_account_id`, `cogs_account_id` UUID NULL with composite FKs `fk_items_asset_account` / `fk_items_cogs_account` → `accounts (org_id, id)` `ON DELETE RESTRICT`. CHECKs: `ck_items_item_type` (`SERVICE`, `NON_INVENTORY`, `INVENTORY`, `FIXED_ASSET`) · `ck_items_kind_matches_type` (`(kind = 'SERVICE') = (item_type = 'SERVICE')`) · `ck_items_stock_accounts` (the two accounts are NULL unless the type is `INVENTORY`/`FIXED_ASSET`). Indexes on both account columns and `(org_id, item_type, is_active, code)`.
- `invoice_lines.stock_location_id`, `bill_lines.stock_location_id` UUID NULL — **no `REFERENCES`**: `stock_locations` belongs to StockLedger and rule 16 overrides rule 8 for a cross-app pointer (the same ruling `032`/`049` made in the other direction); the service validates it.
- `ledger_settings`: `inventory_account_id`, `cogs_account_id`, `inventory_adjustment_account_id`, `stock_opening_account_id` UUID NULL, each with a composite FK to `accounts (org_id, id)` `RESTRICT` and an index.
- Seeds `5050 Cost of Sales — Inventory` and `5400 Inventory Adjustments & Shrinkage` (Expense, postable, children of 5000) for organizations that already have a chart (the `028` pattern; `ON CONFLICT DO NOTHING`). `DEFAULT_CHART` gains the same two rows: **47 accounts, 37 postable**.

**`072_stock_ledger_link.sql`**
- `stock_items.ledger_item_id` UUID NULL — partial unique index `ux_stock_items_org_ledger_item (org_id, ledger_item_id) WHERE ledger_item_id IS NOT NULL`; trigger `trg_stock_items_ledger_link_frozen` raises `0A000` if a set value changes or clears. **No `REFERENCES`** to `items` (rule 16); items are never deleted, only deactivated.
- `stock_settings.default_location_id` UUID NULL, composite FK `fk_stock_settings_default_location` → `stock_locations (org_id, id)` `RESTRICT`, indexed.
- `stock_movements`: `ux_stock_movements_org_id_id UNIQUE (org_id, id)` (the self-FK target) · `source_type` TEXT, `source_id` UUID (`ck_stock_movements_source_pair`: both NULL or both set, type 1–40 chars) · `gl_account_id` UUID (no FK — rule 16; NULL = never touched the GL) · `reverses_movement_id` UUID with composite self-FK `fk_stock_movements_reverses` `RESTRICT`. The movement-type CHECK is widened with `RECEIPT_REVERSAL` and `ISSUE_REVERSAL`; `ck_stock_movements_sign` now treats `ISSUE_REVERSAL` as inbound and `RECEIPT_REVERSAL` as outbound; `ck_stock_movements_reversal_link` requires `reverses_movement_id` exactly for the two reversal types. `ux_stock_movements_reverses` (partial unique) stops a movement being reversed twice; `idx_stock_movements_org_source (org_id, source_type, source_id) WHERE source_id IS NOT NULL`. `ADD COLUMN` does not fire `067`'s append-only trigger — movements stay append-only.

## Phase 33 — one product: schema cleanup (platform) — applied

**`073_platform_drop_app_selection.sql`** drops `organization_apps` (Phase 27's per-organization app selection; nothing reads it once the product has no apps to choose), deletes the `onboarding_states` row keyed `'platform'` (it recorded "has picked its apps", the retired `/welcome` picker), and drops the two trigger functions `reject_forecaster_budget_version_mutation()` / `reject_forecaster_frozen_budget_line_mutation()` that `068` left behind (dropping a table drops its triggers, not the functions they called). `audit_logs` rows about `organization_apps` stay, per `068`'s ruling on history.

**Deliberately kept, and why — the replay constraint.** The audit also found columns no code reads: `ledger_settings.legal_name`/`industry` (superseded by `organization_profiles` in `069`), `integration_drive_connections.folder_id`/`folder_name`/`last_synced_at` and `integration_drive_files.ap_flow_document_id` (superseded in `053`). They **cannot be dropped** under the current rules: `migrations.test.ts` replays every migration against the live schema (the SQL-level idempotency contract), and `053` and `069` contain one-time backfills that `SELECT` those exact columns. Drop them and those two files fail on replay; fixing that means editing an applied migration (rule 13) or squashing the sequence into a baseline (declined 2026-09-25). A migration `074` that dropped them was written, failed the replay test, and was withdrawn in the same change. They are dead weight, not a bug: nothing writes them and nothing reads them. The same constraint explains why `033`–`047` still create 20 tables that `068` drops, and why `docker-compose.yml` keeps the pgvector image.

Also kept, by decision: the `ap_flow_*` / `stock_*` prefixes and the frozen `app_slug` tag values (see the naming section above); `ap_flow_vendor_account_map` keyed by vendor name rather than `vendors.id`; `ap_flow_settings`'s own `id` primary key; `items.kind`, redundant with `item_type` since `071` but still read.

## Phase 34 — automation rules: bank rules & recurring schedules (accounting) — applied

A direct feature request. Migrations `074` and `075`, both `ledger-core`-tagged (accounting module only). See [roadmap.md § Phase 34, as delivered](roadmap.md#phase-34-as-delivered). `074` was written only after the dev/test databases were restored from the withdrawn Phase 33 `074` (see [Phase 33](#phase-33--one-product-schema-cleanup-platform--applied) above), which had already claimed that prefix.

**`074_ledger-core_bank_rules.sql`**
- `bank_rules`: `id`, `org_id` (FK `organizations` `RESTRICT`), `name` (1–80 chars), `priority` INTEGER (0–10000, default 100, lower runs first), `direction` TEXT (`IN`/`OUT`/`ANY`, default `ANY`), `memo_contains` TEXT (1–100 chars), `amount_min_cents`/`amount_max_cents` BIGINT NULL (each `> 0` when set), `bank_account_id` UUID NULL, `target_account_id` UUID NOT NULL, `description` TEXT NULL (1–200 chars when set), `is_active` BOOLEAN, `created_by`, `created_at`, `updated_at`. Constraints: `ux_bank_rules_org_id_id UNIQUE (org_id, id)` (the composite-FK target) · `chk_bank_rules_amount_range` (min `<=` max when both set) · `fk_bank_rules_bank_account`/`fk_bank_rules_target_account` — composite FKs to `accounts (org_id, id)`, both `RESTRICT`. Indexes: `idx_bank_rules_org_active (org_id, priority) WHERE is_active`, plus one each on `bank_account_id`, `target_account_id`, `created_by`. Triggers: `set_updated_at()`, `audit_row_change('ledger-core')`.
- `bank_transactions.matched_rule_id` UUID NULL, with composite FK `fk_bank_txn_rule` → `bank_rules (org_id, id)` `RESTRICT` and `chk_bank_txn_rule_needs_journal` (`matched_rule_id IS NULL OR matched_journal_entry_id IS NOT NULL` — a rule match always implies a posted journal). Indexed.
- `reject_bank_transaction_mutation()` (`019`, then `057`) is `CREATE OR REPLACE`d again: `matched_rule_id` becomes a fourth column, alongside `status`/`matched_payment_id`/`matched_journal_entry_id`/`matched_at`/`matched_by`, exempted from the "only the match state may change" diff — the same trigger function keeps growing its carve-out list one column at a time as Phase 6.1's settlement machinery grows. `CREATE OR REPLACE FUNCTION` is enough; the existing `trg_bank_transactions_immutable` trigger already points at it by name.
- A rule is never deleted, only `is_active = false` — `fk_bank_txn_rule` is `RESTRICT`, matching `058`'s payment-terms precedent for anything with settlement history.

**`075_ledger-core_recurring_schedules.sql`**
- `recurring_schedules`: `id`, `org_id` (FK `organizations` `RESTRICT`), `kind` TEXT (`INVOICE`/`BILL`/`JOURNAL`), `name` (1–80 chars), `source_invoice_id`/`source_bill_id`/`source_journal_entry_id` UUID NULL (exactly one set, matching `kind`), `frequency` TEXT (`WEEKLY`/`MONTHLY`/`QUARTERLY`/`YEARLY`), `interval_count` SMALLINT (1–12, default 1), `start_date` DATE, `end_date` DATE NULL (`>= start_date`), `next_run_date` DATE NULL, `next_occurrence_index` INTEGER (`>= 0`, default 0), `mode` TEXT (`DRAFT`/`POST`, default `DRAFT`), `auto_reverse` BOOLEAN (default `false`), `status` TEXT (`ACTIVE`/`PAUSED`/`ENDED`, default `ACTIVE`), `last_error` TEXT NULL (`<= 500` chars), `last_error_at`, `created_by`, `created_at`, `updated_at`. Constraints: `ux_recurring_schedules_org_id_id` · `chk_recurring_source_matches_kind` (the three source columns are mutually exclusive and match `kind` — a polymorphic `source_id` was rejected precisely so this could be a real, unrepresentable-otherwise CHECK, not just a service-level rule 8 workaround) · `chk_recurring_journal_posts` (`kind <> 'JOURNAL' OR mode = 'POST'`) · `chk_recurring_auto_reverse_journal_only` (`NOT auto_reverse OR kind = 'JOURNAL'`) · `chk_recurring_end_after_start` · `chk_recurring_ended_has_no_next` (`(status = 'ENDED') = (next_run_date IS NULL)`) · composite-style FKs `fk_recurring_source_invoice`/`fk_recurring_source_bill`/`fk_recurring_source_journal` → `invoices`/`bills`/`journal_entries (org_id, id)`, all `RESTRICT` (a template cannot be deleted while a schedule points at it — invoice/bill deletion is draft-only anyway). Indexes: `idx_recurring_schedules_due (next_run_date) WHERE status = 'ACTIVE'` (the sweep's own query), `idx_recurring_schedules_org_kind (org_id, kind, status)`, one each on the three source columns and `created_by`. Triggers: `set_updated_at()`, `audit_row_change('ledger-core')`.
- `recurring_runs` (append-only): `id`, `org_id` (FK `organizations` `RESTRICT`), `schedule_id` UUID NOT NULL, `run_date` DATE, `occurrence_number` INTEGER (`>= 1`), `invoice_id`/`bill_id`/`journal_entry_id`/`reversal_entry_id` UUID NULL, `created_at`. Constraints: `ux_recurring_runs_schedule_date UNIQUE (schedule_id, run_date)` (the second line of defence behind the sweep's row lock for exactly-once generation) · `chk_recurring_runs_one_document` (`num_nonnulls(invoice_id, bill_id, journal_entry_id) = 1`) · an unnamed CHECK (`reversal_entry_id IS NULL OR journal_entry_id IS NOT NULL`) · composite FKs `fk_recurring_runs_schedule` → `recurring_schedules (org_id, id)`, `fk_recurring_runs_invoice`/`_bill`/`_journal_entry`/`_reversal_entry` → their respective tables `(org_id, id)`, all `RESTRICT`. Indexed on `(org_id, schedule_id)` and each of the four document columns.
- `reject_recurring_run_update()` raises SQLSTATE `0A000` on any `UPDATE` via `trg_recurring_runs_append_only BEFORE UPDATE` — a run is history. **Not** installed on `DELETE`, matching the `051` `ai_model_calls` precedent, so a future org-deletion cascade can still remove the rows wholesale even though every FK in this file is `RESTRICT`.
- A schedule is never deleted, only ended (`status = 'ENDED'`, `next_run_date = NULL`) — `fk_recurring_runs_schedule` is `RESTRICT`, so a schedule with any run history cannot be removed, the same reasoning `074`'s bank rules use.

## Phase 35a — inventory ties out to the general ledger (accounting + inventory) — applied

A direct feature request, numbered like Phase 24/30/32/34. Migration `076`, one file spanning both `stock_movements` (inventory) and a new inventory-owned table with no cross-app FK — see [roadmap.md § Phase 35a, as delivered](roadmap.md#phase-35a-as-delivered).

**`076_stock_gl_reconciliation.sql`**
- `stock_movements`'s three CHECKs are widened, guarded the same drop-if-stale/re-add-if-missing way `072` widened them: `stock_movements_movement_type_check` gains `RECLASS_OUT`/`RECLASS_IN` · `stock_movements_quantity_milli_check` becomes `(quantity_milli <> 0 OR movement_type IN ('RECLASS_OUT','RECLASS_IN')) AND abs(quantity_milli) <= 1000000000` (only a RECLASS pair may carry `quantity_milli = 0`) · `ck_stock_movements_sign` gains `(movement_type = 'RECLASS_IN' AND quantity_milli = 0 AND value_cents > 0) OR (movement_type = 'RECLASS_OUT' AND quantity_milli = 0 AND value_cents < 0)`. A RECLASS pair moves an item's already-posted value between two GL accounts without moving stock — `insertMovement`'s balance UPDATE nets to zero across the pair, so `stock_balances` is untouched by it (Core model §3 of the build plan; `stock_balances`'s own `value_cents >= 0` and empty-has-no-value CHECKs would otherwise transiently trip between the two inserts).
- `stock_gl_true_ups` (new, append-only): `id`, `org_id` (FK `organizations` `RESTRICT`), `account_id` UUID NOT NULL (accounts.id — **no `REFERENCES`**: rule 16 over rule 8, the same ruling `072` made for `stock_movements.gl_account_id`), `gl_before_cents`/`subledger_cents`/`difference_cents` BIGINT (`ck_stock_gl_true_ups_arithmetic`: `difference_cents = gl_before_cents - subledger_cents`; `difference_cents <> 0`), `journal_entry_id` UUID NOT NULL (journal_entries.id, same no-FK ruling), `occurred_on` DATE, `created_by` (FK `users` `RESTRICT`), `created_at`. Indexed on `(org_id, created_at)` and `created_by`. `reject_stock_gl_true_up_mutation()` (`0A000`) + `trg_stock_gl_true_ups_immutable BEFORE UPDATE OR DELETE` — a true-up is a permanent audit record of one reconciling journal, the same posture `journal_entries` and `stock_movements` already carry. `trg_stock_gl_true_ups_audit` writes to the shared CDC trail tagged `'stock'`.
- **A one-time backfill**, in the same file: before this phase, `itemService.linkProduct` posted an opening journal for a newly-linked item's on-hand value but wrote no `stock_movements` row recording which GL account that value landed on — pre-link value sat with `gl_account_id IS NULL`, understating the control account by exactly that much. The backfill finds every item linked before 35a with unaccounted value, its own opening journal (`source_type = 'stock', source_id = item.id`), and no existing `RECLASS_IN` row already recording the repair, then inserts one `RECLASS_OUT`/`RECLASS_IN` pair per item — anchored on the item's lowest `(location_id, lot_id)` balance row, valued at the unaccounted sum, targeted at the account the opening journal actually debited (`MIN(account_id)` if more than one line debited, matching the plan's tie-break). Idempotent by construction: a second run finds no qualifying item, since every one it fixed the first time now has that `RECLASS_IN` row.

**Integrity check #7 — `inventory_accounts_reconcile_with_gl`** (`db/integrity.ts`). Control accounts = every `gl_account_id` any `stock_movements` row has ever posted to, plus every `INVENTORY` product's `asset_account_id`, plus (when any `INVENTORY` product has no override) the resolved default inventory account. For each, Σ `stock_movements.value_cents` on that account must equal Σ `ledger_lines.base_debit_cents - base_credit_cents` on it. An organization with pre-35a drift (a manual journal to the account, or a product remapped before the guard existed) fails this check until an `OWNER`/`ADMIN`/`ACCOUNTANT` runs `POST /inventory/reconcile/true-up` — by design; the check exists to surface exactly that, not to hide it. `stock_movements_reconcile_with_gl` (check 6, per-document) is unchanged; this is the whole-account version its own docblock now points readers at.

## Phase 17 — target tables

Sketches only. Specified properly in the migration that creates it.

**`quickbooks_connections`** (Phase 17) — `id` · `org_id` UNIQUE · `realm_id` TEXT · `access_token_encrypted` · `refresh_token_encrypted` · `expires_at` · `connected_by` · `last_synced_at`. Tokens are encrypted at rest, never logged (rule 11).

---

## Conventions

### Account types

Exactly five, forever: `Asset`, `Liability`, `Equity`, `Revenue`, `Expense`. Do not add a sixth.

### Default chart of accounts

**Seeded ✅.** `authService.register` calls `accountService.seedDefaultChart(client, orgId)` inside the transaction that creates the organization — on the checked-out `client`, so a rollback takes the chart with it.

**The backfill is applied ✅.** `003_ledger-core_backfill_chart.sql` seeds every organization that had none, which covers the ones registered during Phases 1–2. It freezes its target list in a temp table before the first insert, because a `NOT EXISTS` predicate repeated per statement would match nothing after the roots were written.

Seeded per **organization** at registration, inside the same transaction that creates the org. Code ranges:

| Range | Type |
|---|---|
| 1000–1999 | Assets |
| 2000–2999 | Liabilities |
| 3000–3999 | Equity |
| 4000–4999 | Revenue |
| 5000–6999 | Expenses |

Reports rely on the numbering convention — keep the ranges intact when extending the seed. The seed belongs in a service (`accountService.seedDefaultChart`), not inlined in a controller.

Indentation below is `parent_id`. **H** marks a header account (`is_postable = false`) — a rollup for reporting that can never receive a posting.

| Code | Name | Type | | Code | Name | Type |
|---|---|---|---|---|---|---|
| **1000** | Assets | Asset **H** | | **4000** | Revenue | Revenue **H** |
| 1100 | · Current Assets | Asset **H** | | 4100 | · Product Revenue | Revenue |
| 1110 | · · Operating Cash | Asset | | 4200 | · Service Revenue | Revenue |
| 1120 | · · Accounts Receivable | Asset | | 4800 | · Sales Returns & Allowances | Revenue |
| 1130 | · · Prepaid Expenses | Asset | | 4910 | · Realized FX Gain | Revenue |
| 1140 | · · Inventory | Asset | | **5000** | Cost of Goods Sold | Expense **H** |
| 1180 | · · GST/VAT Input Credit | Asset | | 5100 | · Direct Materials | Expense |
| 1400 | · Non-Current Assets | Asset **H** | | 5200 | · Direct Labor | Expense |
| 1500 | · · Fixed Assets / Equipment | Asset | | 5300 | · Freight & Duty | Expense |
| 1590 | · · Accumulated Depreciation | Asset | | **6000** | Operating Expenses | Expense **H** |
| **2000** | Liabilities | Liability **H** | | 6100 | · Salaries & Wages | Expense |
| 2010 | · Current Liabilities | Liability **H** | | 6110 | · Rent & Utilities | Expense |
| 2100 | · · Accounts Payable | Liability | | 6120 | · Software & IT Infrastructure | Expense |
| 2120 | · · Accrued Liabilities | Liability | | 6130 | · Office Supplies | Expense |
| 2140 | · · GST/VAT Output Payable | Liability | | 6140 | · Kitchen & Breakroom | Expense |
| 2160 | · · Payroll Liabilities | Liability | | 6200 | · Professional Fees | Expense |
| 2500 | · Non-Current Liabilities | Liability **H** | | 6300 | · Travel & Entertainment | Expense |
| 2510 | · · Notes Payable | Liability | | 6400 | · Marketing & Advertising | Expense |
| **3000** | Equity | Equity **H** | | 6500 | · Depreciation Expense | Expense |
| 3100 | · Common Stock / Owner's Capital | Equity | | 6600 | · Bank Fees | Expense |
| 3200 | · Retained Earnings | Equity | | 6810 | · Realized FX Loss | Expense |
| 3300 | · Owner's Draw | Equity | | 6820 | · Unrealized FX Gain/Loss | Expense |
| 3400 | · Opening Balance Equity | Equity | | | | |

**Forty-five accounts: 35 postable leaves and 10 header rollups.** The two counts matter separately — only the 35 can receive a posting, and only they appear on a trial balance. Four groups exist to pay debts forward rather than because Phase 3 needs them, which is deliberate — adding an account to the seed later means writing *another* backfill for every organization created in between:

- **`1180` / `2140` (tax)** — AP-Flow splits input tax out of an invoice total into a dedicated account (Phase 11).
- **`4910` / `6810` / `6820` (FX)** — the multi-currency engine posts realized gain or loss on settlement and unrealized movement at period end (Phase 8).
- **`3400` (opening balance equity)** — a business migrating off another system plugs its trial balance's imbalance here rather than into `3200`, which is derived and never posted (Phase 9b). Added by `028_ledger-core_opening_balance_equity.sql`, with a backfill mirroring `003`'s for every organization that predates it — the count went from 44 to 45 on 2026-09-10.
- **`5000` and `6000` are both `Expense`.** COGS and operating expenses are separated by code range and by parent, not by a sixth account type. Rule 12 is not negotiable: the type list is exactly five. The P&L (Phase 4) derives gross profit from the `5xxx` range, which is why the ranges above are load-bearing rather than cosmetic.

Codes are chosen to match the worked examples in [accounting.md](accounting.md) and [capture.md](capture.md) literally — `6120 Software & IT Infrastructure` debited against `2100 Accounts Payable` for a cloud bill, `1500 Fixed Assets / Equipment` against `1110 Operating Cash` for a hardware receipt, and a supermarket receipt split across `6130` and `6140`.
