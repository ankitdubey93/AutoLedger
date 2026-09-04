# Database Schema

**Applied: `001`–`005`.** `organizations`, `users`, `organization_members`, `refresh_tokens`, `accounts`, `journal_entries`, `ledger_lines` and `ledger_settings` all exist, with the balance, immutability and `updated_at` triggers live. The **Phase 4+** section further down is still target state and is marked as such. Keep this file verified against `server/src/db/migrations/`.

Apply with `npm run migrate`; rebuild from scratch with `npm run db:reset`. The runner records a SHA-256 checksum per file and **refuses to run if an applied migration has been edited** — rule 13 is enforced by the tooling, not by memory.

Migrations live in `server/src/db/migrations/` **only**, applied in sorted filename order — one shared sequence across every app in the suite, not one per app.

## Table naming across apps

All seven apps share one database and one migration sequence. Table names disambiguate which app owns them:

- **LedgerCore is unprefixed** (`accounts`, `journal_entries`, `ledger_lines`) — it is the shared system of record every other app posts into, the same reason `organizations` and `users` are unprefixed platform tables.
- **Every other app prefixes its own tables** with its slug: `ap_flow_invoices`, `fpa_scenarios`, `taxguard_documents`, `unitecon_cohorts`, `boarddeck_decks`, `forecaster_budgets`. An app's tables are never read by another app directly — cross-app effects go through LedgerCore's GL via `source_type` / `source_id`.

Migration filenames tag the app they belong to: `NNN_<app-slug>_<subject>.sql`, e.g. `002_ledger-core_accounts.sql`. Platform migrations (like `001`) carry no app tag.

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

## Phase 3 — General Ledger (LedgerCore) ✅ applied

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

**Deliberately no seed row and no backfill migration.** The absence of a `ledger_settings` row *is* the "onboarding not yet completed" signal — correct for every organization that predates this migration, which is why `onboarded_at` is `NOT NULL`: the row only ever exists once onboarding actually completed. `GET /ledger-core/settings` returns `200` with `onboardedAt: null` and sensible defaults for a missing row, never a `404`.

**`organizationName` and `baseCurrency` are not columns on this table.** Both remain on `organizations` (Phase 1) and are edited through `PATCH /organizations`, a platform route — see [architecture.md](architecture.md#suite-structure)'s platform/app split. `ledger_settings` only owns fields LedgerCore itself is responsible for.

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

`server/src/types/ledger-core.ts`'s `INVOICE_TRANSITIONS` (`DRAFT -> [ISSUED, VOID]`, `ISSUED -> [VOID]`, `VOID -> []`) is the one place a status transition is decided in code; the `status` CHECK above lists the identical three values. See [study/architecture/document-lifecycle-fsm.md](../study/architecture/document-lifecycle-fsm.md).

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

**Not built in this phase:** an expense-claim/employee-reimbursement document, credit notes, vendor credits, partial void, PDF export, multi-currency payments, fiscal-period posting locks, audit trail. None of these are silently implied by anything above.

---

## Phase 4+ — target tables

Sketches only. Each is specified properly in the migration that creates it; they are listed here so the shape of the whole schema is visible and so Phase 3 can seed forward-compatible accounts rather than leaving later phases a backfill.

**`fiscal_periods`** (Phase 4) — `id` · `org_id` · `starts_on` DATE · `ends_on` DATE · `status` TEXT CHECK IN (`open`,`closed`,`locked`) · `closed_by` · `closed_at`. `EXCLUDE USING GIST` on `(org_id WITH =, daterange(starts_on, ends_on) WITH &&)` so overlapping periods are physically impossible — requires `btree_gist`. A posting into a closed period is rejected by trigger.

**`audit_logs`** (Phase 5) — `id` · `org_id` · `table_name` · `row_id` · `operation` TEXT CHECK IN (`INSERT`,`UPDATE`,`DELETE`) · `old_row` JSONB · `new_row` JSONB · `actor_user_id` · `client_ip` INET · `occurred_at`. Written by a generic trigger function attached to every financial table. Append-only, same `reject_mutation()` treatment.

**`bank_transactions`** (Phase 6) — `id` · `org_id` · `statement_import_id` · `posted_on` DATE · `amount_cents` BIGINT (signed — a bank line is directional, unlike a ledger line) · `currency_code` · `counterparty` TEXT · `memo` TEXT · `external_ref` TEXT · `status` TEXT CHECK IN (`unmatched`,`suggested`,`reconciled`,`ignored`) · `dedupe_hash` TEXT with `UNIQUE (org_id, dedupe_hash)` so re-importing the same statement is idempotent.

**`reconciliation_matches`** (Phase 6) — `id` · `org_id` · `bank_transaction_id` · `journal_entry_id` · `score` SMALLINT CHECK between 0 and 100 · `score_breakdown` JSONB (the amount/date/name components, so a score is explainable rather than a magic number) · `decided_by` · `decided_at` · `status` TEXT CHECK IN (`suggested`,`accepted`,`rejected`).

**`fx_rates`** (Phase 8) — `id` · `base_code` CHAR(3) · `quote_code` CHAR(3) · `rate_date` DATE · `rate` NUMERIC(18,8) · `source` TEXT. `UNIQUE (base_code, quote_code, rate_date)`. **No `org_id`** — an exchange rate is a fact about the world, not tenant data; this is one of the two tables that legitimately has no tenant scope (`users` is the other). Lookup is "the latest rate on or before this date", never an exact-date match, because rate feeds have gaps on weekends and holidays.

**`quickbooks_connections`** (Phase 9) — `id` · `org_id` UNIQUE · `realm_id` TEXT · `access_token_encrypted` · `refresh_token_encrypted` · `expires_at` · `connected_by` · `last_synced_at`. Tokens are encrypted at rest, never logged (rule 11).

**`ap_flow_documents`** (Phase 10) — `id` · `org_id` · `sha256` TEXT · `mime_type` TEXT · `byte_size` BIGINT · `original_filename` TEXT · `page_count` INT · `redaction_status` TEXT CHECK IN (`pending`,`redacted`,`failed`) · `redacted_regions` JSONB (the bounding boxes that were masked, so the decision is auditable) · `uploaded_by` · `created_at`. `UNIQUE (org_id, sha256)` — uploading the same receipt twice is one document.

**`ap_flow_extractions`** (Phase 10) — `id` · `org_id` · `document_id` · `model` TEXT · `payload` JSONB (the structured invoice) · `field_confidence` JSONB (per-field 0–1, what the review UI colours) · `extracted_at`. One row per extraction attempt; a re-run adds a row rather than overwriting one.

**`ap_flow_line_items`** (Phase 11) — `id` · `org_id` · `document_id` · `line_no` INT · `description` TEXT · `amount_cents` BIGINT · `tax_cents` BIGINT · `suggested_account_id` FK → `accounts` · `confirmed_account_id` FK → `accounts`. Distinct accounts per line is the point: one supermarket receipt splits across `6130 Office Supplies` and `6140 Kitchen & Breakroom`.

**`ap_flow_vendor_account_map`** (Phase 11) — `id` · `org_id` · `vendor_name_normalized` TEXT · `account_id` FK → `accounts` · `hit_count` INT · `last_used_at`. `UNIQUE (org_id, vendor_name_normalized)`. The organization's own posting history, which is consulted **before** any model is asked to classify — a vendor seen ten times needs no inference.

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

**Forty-four accounts: 34 postable leaves and 10 header rollups.** The two counts matter separately — only the 34 can receive a posting, and only they appear on a trial balance. Three groups exist to pay debts forward rather than because Phase 3 needs them, which is deliberate — adding an account to the seed later means writing *another* backfill for every organization created in between:

- **`1180` / `2140` (tax)** — AP-Flow splits input tax out of an invoice total into a dedicated account (Phase 11).
- **`4910` / `6810` / `6820` (FX)** — the multi-currency engine posts realized gain or loss on settlement and unrealized movement at period end (Phase 8).
- **`5000` and `6000` are both `Expense`.** COGS and operating expenses are separated by code range and by parent, not by a sixth account type. Rule 12 is not negotiable: the type list is exactly five. The P&L (Phase 4) derives gross profit from the `5xxx` range, which is why the ranges above are load-bearing rather than cosmetic.

Codes are chosen to match the worked examples in [ledger-core.md](ledger-core.md) and [ap-flow.md](ap-flow.md) literally — `6120 Software & IT Infrastructure` debited against `2100 Accounts Payable` for a cloud bill, `1500 Fixed Assets / Equipment` against `1110 Operating Cash` for a hardware receipt, and a supermarket receipt split across `6130` and `6140`.
