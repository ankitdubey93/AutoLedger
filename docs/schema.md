# Database Schema

**Applied: `001`–`026`.** Platform identity/tenancy, LedgerCore's GL core (accounts, journals, the balance/immutability triggers), settings, invoicing (customers, invoices), accounts payable (vendors, bills, payments), Phase 4's fiscal periods with the closed-period posting guard, Phase 5's shared `audit_logs` CDC trail, Phase 6's bank reconciliation (statement imports, bank transactions, scored match suggestions), Phase 7's transactional outbox and webhook tables, and Phase 8's five FX migrations (`fx_rates`, the base-currency balance redefinition, document and payment FX columns, `fx_revaluations`) all exist. The **Phase 9+** section further down is still target state and is marked as such. Keep this file verified against `server/src/db/migrations/`.

Apply with `npm run migrate`; rebuild from scratch with `npm run db:reset`. The runner records a SHA-256 checksum per file and **refuses to run if an applied migration has been edited** — rule 13 is enforced by the tooling, not by memory.

Migrations live in `server/src/db/migrations/` **only**, applied in sorted filename order — one shared sequence across every app in the suite, not one per app.

## Table naming across apps

All seven apps share one database and one migration sequence. Table names disambiguate which app owns them:

- **LedgerCore is unprefixed** (`accounts`, `journal_entries`, `ledger_lines`) — it is the shared system of record every other app posts into, the same reason `organizations` and `users` are unprefixed platform tables.
- **Every other app prefixes its own tables** with its slug: `ap_flow_invoices`, `fpa_scenarios`, `taxguard_documents`, `unitecon_product_lines`, `boarddeck_decks`, `forecaster_budgets`. An app's tables are never read by another app directly — cross-app effects go through LedgerCore's GL via `source_type` / `source_id`. UnitEcon has no `unitecon_cohorts` table — a cohort matrix is derived on every request, never stored (see Phase 14 below).

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
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE RESTRICT · `import_id` UUID NOT NULL, composite FK → `bank_statement_imports (org_id, id)` ON DELETE RESTRICT · `account_id` UUID NOT NULL, composite FK → `accounts (org_id, id)` ON DELETE RESTRICT · `txn_date` DATE NOT NULL · `description` TEXT NOT NULL CHECK <= 500 · `external_reference` TEXT (nullable, <= 100) · `currency_code` CHAR(3) NOT NULL · `amount_cents` BIGINT NOT NULL CHECK <> 0 — **signed**: positive is money in, negative is money out, unlike a `ledger_lines` row which always has exactly one side populated · `dedupe_hash` CHAR(64) NOT NULL · `status` TEXT NOT NULL DEFAULT `'UNMATCHED'` CHECK IN (`UNMATCHED`,`MATCHED`,`IGNORED`) · `matched_payment_id` UUID (nullable), composite FK → `payments (org_id, id)` ON DELETE RESTRICT · `matched_at` TIMESTAMPTZ (nullable) · `matched_by` FK → `users` ON DELETE RESTRICT (nullable) · `created_at` / `updated_at`.

Constraints: `ux_bank_transactions_org_id_id` — `UNIQUE (org_id, id)`, the standard composite-FK-target convention · **`ux_bank_transactions_dedupe`** — `UNIQUE (org_id, dedupe_hash)`, what makes re-importing the same statement idempotent (the hash folds in an occurrence ordinal so two genuinely identical lines in one file both survive — see [study/postgresql/idempotent-ingestion-and-dedupe-hashes.md](../study/postgresql/idempotent-ingestion-and-dedupe-hashes.md)) · `chk_bank_txn_matched_fields` — the "posted-complete" idiom again: `matched_payment_id`/`matched_at`/`matched_by` are all set when `status = 'MATCHED'` and all `NULL` otherwise.

**`bank_match_suggestions`** — up to 5 scored candidates per unmatched line, deleted and regenerated wholesale on every rescore:
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE **CASCADE** (the one FK in this table pair that cascades, since a suggestion is disposable derived data, not a record of fact) · `bank_transaction_id` UUID NOT NULL, composite FK → `bank_transactions (org_id, id)` ON DELETE CASCADE · `target_type` TEXT NOT NULL CHECK IN (`invoice`,`bill`) · `invoice_id` / `bill_id` UUID (nullable), composite FKs → `invoices`/`bills (org_id, id)` ON DELETE RESTRICT, `chk_bank_suggestion_one_target` requiring exactly one set, matching `target_type` · `score` INTEGER NOT NULL CHECK BETWEEN 0 AND 100 · `score_breakdown` JSONB NOT NULL — `{ amount, date, counterparty }`, each `{ points, maxPoints, reason }`, so a score is explainable rather than a magic number · `created_at`.

**Immutability.** `bank_transactions` gets the same `to_jsonb` row-diff carve-out treatment as `payments` (migration 014): `reject_bank_transaction_mutation()` permits changing only `status`/`matched_payment_id`/`matched_at`/`matched_by`, raises `0A000` on any other column change or on `DELETE` — a bank line is a record of fact from a downloaded statement, never edited or removed. `bank_statement_imports` and `bank_match_suggestions` carry no immutability trigger; an import's counts are updated once, in the same transaction that inserts its lines, and suggestions are deliberately disposable.

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

**`023_ledger-core_base_currency_balance.sql`** — "base currency is what balances." Redefines `assert_journal_entry_balanced()` (004) — `004` itself is not edited, and its checksum is unchanged; the two `CONSTRAINT TRIGGER`s it created pick up the new function body automatically. The **base-currency** sum check (`SUM(base_debit_cents) = SUM(base_credit_cents)`) is now unconditional, on every entry, always. The **native-currency** sum check now fires only when `COUNT(DISTINCT currency_code) = 1` across the entry's lines — every entry Phases 3–7 ever wrote, and every base-currency entry this phase and later ones write, is still checked exactly as strictly as before. A realized-FX settlement entry legitimately mixes a foreign-currency receivable line with a base-currency gain/loss line (see [ledger-core.md § 3](ledger-core.md#3-realized-fx--the-worked-example)); summing those native amounts together would be meaningless, so only the base-currency sum is asked to balance for it. This is the standard functional-currency accounting rule. See [study/postgresql/multi-currency-and-functional-currency.md](../study/postgresql/multi-currency-and-functional-currency.md).

Also adds `chk_ledger_lines_base_matches_rate` on `ledger_lines`: `CHECK (base_debit_cents = round(debit_cents * fx_rate) AND base_credit_cents = round(credit_cents * fx_rate))`. Valid against the whole table with no backfill, since every pre-Phase-8 row was written at `fx_rate = 1`. Postgres `round(numeric)` rounds half away from zero — the same rule `utils/money.ts`'s `scaleCents` (via `utils/fxRate.ts`'s `convertToBase`) applies for the non-negative amounts every ledger line holds, which is what lets the service and the database agree to the cent on every conversion.

`journalService.createEntryOnClient` resolves each line's currency and rate (omitted means the organization's base currency at rate `1.00000000`, byte-identical to the pre-Phase-8 behaviour), converts every line to base with `convertToBase`, and pre-checks both the conditional native sum and the unconditional base sum before ever reaching the database — the same "checked twice, service and trigger" doctrine every other invariant in this schema follows.

**`024_ledger-core_document_fx.sql`** — foreign-currency `invoices`/`bills`. Each table gains `fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1` and `base_subtotal_cents`/`base_tax_cents`/`base_total_cents BIGINT NOT NULL DEFAULT 0`, backfilled from the native `subtotal_cents`/`tax_cents`/`total_cents` for every pre-existing row (all of them at `fx_rate = 1`, so base already equals native). `chk_invoices_fx_rate`/`chk_bills_fx_rate` mirror `chk_fx_rates_rate_range`. `chk_invoices_base_total`/`chk_bills_base_total` require `base_total_cents = base_subtotal_cents + base_tax_cents` — **deliberately not** `base_total_cents = round(total_cents * fx_rate)`: the base total is the sum of two independently-rounded components (subtotal and tax), which may legitimately differ from the rounded total by a cent, and the actual rate-agreement CHECK lives on `ledger_lines` (023), built from those same per-component amounts.

`invoiceService`/`billService` resolve the document's rate (identity when its currency matches the org's base currency, otherwise the latest `fx_rates` row on or before the document's date) on every draft save — so a draft always displays an honest base-currency total — and **freeze** it again at `issue`/`approve`, re-resolved against the actual posting date (which can differ from the document's own date via `entryDate`). Once posted, the rate never changes; every later settlement compares its own rate against this frozen one. The posted journal entry's lines carry the document's own `currency_code` and frozen `fx_rate`, converted to base currency via `utils/fxRate.ts`'s `convertToBase` — a foreign-currency invoice or bill posts real foreign-currency amounts, not a base-currency approximation.

**`025_ledger-core_payment_fx.sql`** — foreign-currency `payments`, realized-FX posting accounts, and the allocation currency guard.

`payments` gains `fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1` and `base_amount_cents BIGINT NOT NULL DEFAULT 0` (backfilled from `amount_cents` for every pre-existing row); `chk_payments_fx_rate` mirrors `chk_fx_rates_rate_range`. `payment_allocations` gains `base_amount_cents BIGINT NOT NULL DEFAULT 0` — a **deliberate exception** to this codebase's "derive, never store" discipline (see [study/architecture/derived-vs-stored-state.md](../study/architecture/derived-vs-stored-state.md)): recomputing a rounded conversion at read time could drift from the ledger line's own `base_debit_cents`/`base_credit_cents` by a cent, and a subledger that does not tie to the GL to the cent is worse than one redundant column.

`ledger_settings` gains three nullable composite-FK columns mirroring `012`'s AP posting accounts exactly — `realized_fx_gain_account_id`, `realized_fx_loss_account_id`, `unrealized_fx_account_id`, each `FOREIGN KEY (org_id, *) REFERENCES accounts (org_id, id) ON DELETE RESTRICT`, each indexed. Unlike `012`'s columns (which have no read/write path through the API to this day), Phase 8 exposes all three through `GET`/`PATCH /ledger-core/settings` — see [api.md](api.md). `NULL` falls back to chart codes `4910`/`6810`/`6820` in the service, seeded for every organization since Phase 3.

**`trg_allocations_currency`** (`assert_allocation_currency_matches()`) — a plain `BEFORE INSERT` trigger on `payment_allocations`: a payment may only allocate to a document sharing its own `currency_code`. Deliberately returns `NEW` without raising (leaving the outcome to `chk_allocation_one_target` or the composite FKs) when neither target is set or the target id doesn't resolve to a row in this org — a `BEFORE` trigger fires ahead of `CHECK`/FK validation, so raising unconditionally would preempt those constraints' own, more specific errors for a malformed row. Both of its lookups carry `org_id`, so it is a tenancy boundary as well as a currency one.

**`paymentService.createPaymentOnClient`'s realized-FX plug**, the mechanism this migration exists to support: for a foreign-currency payment, `imbalance = Σ(line base debits) − Σ(line base credits)` over the cash line (native currency at the settlement-date rate) and one control line per allocation (native currency at *that document's own frozen rate*). `imbalance > 0` credits `4910 Realized FX Gain`; `imbalance < 0` debits `6810 Realized FX Loss`; `imbalance = 0` posts no FX line at all. One subtraction handles both a receivable settled high (a gain) and a payable settled high (a loss, the mirror case) with no direction-specific sign branch — see [ledger-core.md § 3](ledger-core.md#3-realized-fx--the-worked-example) and [study/architecture/realized-and-unrealized-fx.md](../study/architecture/realized-and-unrealized-fx.md). A base-currency payment's GL shape is untouched — still exactly the two lines Phase 3.9 posted.

**`026_ledger-core_fx_revaluations.sql`** — period-end unrealized revaluation, closing out Phase 8.

**`fx_revaluations`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE RESTRICT · `as_of_date` DATE · `journal_entry_id`/`reversal_journal_entry_id` UUID NOT NULL, each a composite FK → `journal_entries (org_id, id)` ON DELETE RESTRICT · `total_delta_cents` BIGINT **signed** (no `>= 0` CHECK — a revaluation delta is not a "money ≥ 0" amount, matching `bank_transactions.amount_cents` rather than every other money column in this schema) · `line_count` INTEGER `CHECK (> 0)` · `created_by`/`created_at`. `ux_fx_revaluations_org_date` — `UNIQUE (org_id, as_of_date)`, what `POST /fx-revaluations` turns into a `409` on a repeat date.

**`fx_revaluation_lines`** — one row per open foreign-currency document included in a revaluation: `revaluation_id` composite FK → `fx_revaluations (org_id, id)` ON DELETE CASCADE (the detail dies with its parent) · `invoice_id` XOR `bill_id` (`chk_fx_revaluation_line_one_target`, the same idiom as `payment_allocations`) · `currency_code`, `outstanding_cents`, `document_rate`, `revaluation_rate`, `carrying_base_cents`, `revalued_base_cents`, and a signed `delta_cents`.

**Deliberately no status column and no FSM** — unlike every other lifecycle table in this schema. A revaluation is created posted and stays posted forever; a wrong one is corrected by the *next* period's revaluation, the same way an accountant would, never by editing or voiding this one.

**Audited on the parent only.** `fx_revaluation_lines` is derived data computed at the moment a revaluation runs and never regenerated in place — closer to `payment_allocations` (a permanent record) than to `bank_match_suggestions` (deleted and rewritten wholesale on every rescore), but the parent row's own `total_delta_cents`/`line_count` already summarize it for compliance purposes, so only `fx_revaluations` carries `audit_row_change('ledger-core')`.

**`fxRevaluationService.runRevaluation`** posts one journal entry dated `asOfDate` restating every open foreign-currency invoice/bill at the as-of exchange rate, through `6820 Unrealized FX Gain/Loss` — **a single account for both directions**, unlike the realized `4910`/`6810` pair, because an unrealized revaluation is one economic event regardless of which way it moves. Uses the same imbalance-as-plug technique as `paymentService.createPaymentOnClient`'s realized settlement: build the AR/AP restatement lines from each document's `(revaluedBase − carryingBase)` delta, then let `6820` absorb whatever those lines don't already balance. Immediately posts a **second** entry — `journalService.reverseEntryOnClient` dated the calendar day after `asOfDate` — reversing the first. That reversal is what keeps *realized* FX correct at the next real settlement: `paymentService` always compares a payment's rate against the document's **original frozen** `fx_rate`, never against a revalued carrying amount, and the next-day reversal is what guarantees the revaluation's effect does not linger into that comparison. See [ledger-core.md § 3](ledger-core.md#3-realized-fx--the-worked-example) and [study/architecture/realized-and-unrealized-fx.md](../study/architecture/realized-and-unrealized-fx.md).

`GET /ledger-core/reports/fx-exposure` runs the identical computation read-only — same query, same per-currency rate resolution, zero writes — so a user can preview a revaluation's effect before committing to it.

This closes Phase 8's scope as specified in [ledger-core.md § D](ledger-core.md#d-multi-currency-fx-engine--phase-8): `fx_rates` and the latest-on-or-before lookup (022), base currency as the balancing invariant (023), foreign-currency invoices and bills (024), foreign-currency payments with realized settlement gain/loss (025), and period-end unrealized revaluation (026).

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

See [ledger-core.md § Phase 9b](ledger-core.md#phase-9b--chart--opening-balance-import) for the commit semantics (parent-before-child chart resolution, the imbalance-as-plug computation, the three refused accounts) and [api.md](api.md#migration-imports--apiv1ledger-coremigration-imports--phase-9b) for the routes.

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

**`ap_flow_documents`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `document_id` UUID NOT NULL, composite FK `(org_id, document_id) → documents (org_id, id)` ON DELETE CASCADE (the platform vault row this registers — bytes, hash, MIME type and filename all live there, never duplicated here) · `status` TEXT NOT NULL DEFAULT `'PENDING'`, CHECK IN (`PENDING`,`PROCESSING`,`EXTRACTED`,`FAILED`) originally, widened to add `POSTED` in migration 032 (Phase 11 — see below) · `page_count` INT NULL, CHECK `> 0` when present · `failure_reason` TEXT NULL, `<= 1000` chars · `processing_started_at`/`processed_at` TIMESTAMPTZ NULL · `created_by` FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at` TIMESTAMPTZ NOT NULL DEFAULT `now()`, `updated_at` bumped by a `set_updated_at` trigger. `ux_ap_flow_documents_document` — `UNIQUE (org_id, document_id)`, one AP-Flow registration per vault document per tenant. `ux_ap_flow_documents_org_id_id` — the composite target the other two tables reference.

**`ap_flow_pages`** — one row per rasterized/redacted page. `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `ap_flow_document_id` UUID NOT NULL, composite FK → `ap_flow_documents (org_id, id)` ON DELETE CASCADE · `page_number` INT NOT NULL CHECK `>= 1` · `width_px`/`height_px` INT NOT NULL CHECK `> 0` · `redacted_sha256` CHAR(64) NOT NULL, CHECK lowercase hex (the hash of the **redacted** page, stored back through `storageService.put` — the unredacted raster is never persisted anywhere) · `ocr_text` TEXT NOT NULL (the unredacted local OCR text — stored, but **never returned by the API**; returning it would undo the redaction) · `redacted_regions` JSONB NOT NULL DEFAULT `'[]'` (the exact boxes masked, with their PII kind, so the redaction decision is itself auditable) · `created_at`. `ux_ap_flow_pages_number` — `UNIQUE (org_id, ap_flow_document_id, page_number)`.

**`ap_flow_extractions`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `ap_flow_document_id` UUID NOT NULL, composite FK → `ap_flow_documents (org_id, id)` ON DELETE CASCADE · `vendor_name`/`invoice_number` TEXT NULL, length-capped · `invoice_date` DATE NULL · `currency` CHAR(3) NULL, CHECK `~ '^[A-Z]{3}$'` · `subtotal_cents`/`tax_cents`/`total_cents` BIGINT NULL, CHECK `>= 0` · `line_items` JSONB NOT NULL DEFAULT `'[]'` · `field_confidence` JSONB NOT NULL DEFAULT `'{}'` (0–1 per field, what Phase 11's review UI will colour) · `arithmetic_ok` BOOLEAN NOT NULL (line items vs. subtotal, subtotal+tax vs. total — flagged, never silently accepted or auto-rejected, since Phase 10 posts nothing to reject) · `validation_errors` JSONB NOT NULL DEFAULT `'[]'` · `model` TEXT NOT NULL, non-blank CHECK · `created_at`. `ux_ap_flow_extractions_document` — `UNIQUE (org_id, ap_flow_document_id)`: **one current extraction per document**, not a history table — a re-extraction `DELETE`s the old row and `INSERT`s a fresh one inside the same transaction that moves `status` to `EXTRACTED`. What a prior attempt said survives only in `audit_logs`.

**Immutability, narrower than a posted financial document's (rule 6 is about posted documents; these are pre-posting drafts).** `reject_ap_flow_mutation()` (`BEFORE UPDATE`, raising `0A000`) is attached to `ap_flow_pages` and `ap_flow_extractions` — what the model said on a given run stays non-repudiable. **`DELETE` stays legal on both** — re-extraction depends on it — refused nowhere by a trigger; the service deletes and re-inserts inside one transaction. `ap_flow_documents.status` itself is mutable (a plain column, no immutability trigger) as of Phase 10, gated instead by `AP_FLOW_DOCUMENT_TRANSITIONS`, the FSM table in `types/ap-flow.ts`. Phase 11 (below) adds this table's first terminal state and a matching trigger.

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

## Phase 12 — FP&A Engine linked model — applied

`033_fpa-engine_models.sql` adds two tables; `034_fpa-engine_assumptions.sql` adds a third.

**`fpa_models`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `name` TEXT NOT NULL, non-blank, `<= 120` chars · `description` TEXT NULL, `<= 1000` chars · `starts_on` DATE NOT NULL, CHECK `EXTRACT(DAY FROM starts_on) = 1` (monthly calendar buckets, not LedgerCore's fiscal periods) · `horizon_months` INT NOT NULL, CHECK `1..60` · `actuals_through` DATE NOT NULL, same first-of-month CHECK · `status` TEXT NOT NULL DEFAULT `'DRAFT'`, CHECK IN (`DRAFT`,`ACTIVE`,`ARCHIVED`) · `created_by` FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at`, bumped by `set_updated_at`. `ux_fpa_models_name` — `UNIQUE (org_id, name)`. `ux_fpa_models_org_id_id` — the composite target `fpa_scenarios` references. `chk_fpa_models_actuals_before_start` — CHECK `actuals_through < starts_on`.

**`fpa_scenarios`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `model_id` UUID NOT NULL, composite FK → `fpa_models (org_id, id)` ON DELETE CASCADE · `name` TEXT NOT NULL, non-blank, `<= 120` chars · `kind` TEXT NOT NULL, CHECK IN (`BASE`,`UPSIDE`,`DOWNSIDE`,`CUSTOM`) · `is_default` BOOLEAN NOT NULL DEFAULT `false` · `dso_days`/`dpo_days` INT NOT NULL DEFAULT `0`, CHECK `0..365` · `tax_rate_bps` INT NOT NULL DEFAULT `0`, CHECK `0..10000` · `created_at`/`updated_at`. `ux_fpa_scenarios_name` — `UNIQUE (org_id, model_id, name)`. **`ux_fpa_scenarios_one_default`** — a **partial unique index** `ON fpa_scenarios (org_id, model_id) WHERE is_default`, proving exactly one default scenario per model at the database level, the same technique migration 029's `ux_migration_imports_one_committed_opening` uses.

**`fpa_assumptions`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `scenario_id` UUID NOT NULL, composite FK → `fpa_scenarios (org_id, id)` ON DELETE CASCADE · `account_id` UUID NOT NULL (**no `REFERENCES`** — see below) · `kind` TEXT NOT NULL, CHECK IN (`GROWTH_BPS`,`FIXED_CENTS`,`PERCENT_OF_REVENUE_BPS`) · `growth_bps` INT NULL, CHECK `-10000..100000` · `fixed_cents` BIGINT NULL (**no `>= 0` CHECK** — a contra-revenue or credit-side assumption legitimately reads negative, mirroring `ap_flow_line_items.amount_cents`) · `percent_of_revenue_bps` INT NULL, CHECK `0..10000` · `created_at`/`updated_at`. `ux_fpa_assumptions_account` — `UNIQUE (org_id, scenario_id, account_id)`, one assumption per account per scenario. **`chk_fpa_assumptions_kind_payload`** — a discriminated union expressed as a CHECK: the column the `kind` names is `NOT NULL` and the other two are `NULL`, so a `GROWTH_BPS` row can never carry a stale `fixed_cents`.

**No `NUMERIC` anywhere in these three tables.** `dso_days`/`dpo_days`/`tax_rate_bps`/`growth_bps`/`percent_of_revenue_bps` are all plain `INT` basis points — every application downstream is `scaleCents(amount, n, 10000 | 30)`, exact `BigInt` scaling (guardrails rule 3). Contrast with `fx_rates.rate` (022), which genuinely needs 8 decimal places and pays for that by staying a string end to end.

**No immutability trigger on any of the three tables, and no terminal FSM state.** Every other FSM in this schema enforces immutability once a document reaches the general ledger — `ap_flow_documents.POSTED` (032), `fiscal_periods.LOCKED` (015), `migration_imports.COMMITTED` (029). FP&A posts nothing to the GL, ever: a model and its scenarios are read-only arithmetic containers, never a source document, so rule 6 ("posted financial documents are immutable") does not apply and `PATCH`/`DELETE` on a model, scenario, or assumption are correct, not a violation.

**Why `account_id` carries no `REFERENCES` here, the same ruling `ap_flow_line_items.account_id` (032) already carries.** Rules 8 and 16 collide on this column, and 16 wins: a schema-level FK from an FP&A table into LedgerCore's `accounts` table would hard-wire the app boundary into the database itself. Validity is enforced at the service layer instead — `assumptionService.upsertAssumption` calls `accountService.getAccountById` (`404` cross-tenant), refuses a non-postable or inactive account, and refuses `PERCENT_OF_REVENUE_BPS` on a Revenue account (the circularity guard the projection engine's two-pass design depends on). Safe because accounts are never actually deleted in this codebase — retired via `is_active = false` — so a dangling `account_id` is not a reachable state.

**All three tables are audited** (`trg_fpa_models_audit`/`trg_fpa_scenarios_audit`/`trg_fpa_assumptions_audit`, `audit_row_change('fpa-engine')`) — a scenario's assumptions are business state a user deliberately sets, not derived output regenerated wholesale, the ruling `bank_match_suggestions`/`ap_flow_pages` carry in the opposite direction.

No new table holds a projection. `GET /scenarios/:id/projection` computes every figure fresh from `fpa_assumptions` plus two functions exported from `reportService` (`monthlyActualsByAccount`, `resolveControlAccounts`) on every request — the same "no summary table" discipline `reportService`'s own header states for the trial balance and P&L.

See [api.md](api.md#fpa-engine--apiv1fpa-engine--phase-12) for the routes and [fpa-engine.md](fpa-engine.md) for the full projection arithmetic.

## Phase 13 — ForecasterPro — applied

`035_forecaster_plans.sql` adds `forecaster_plans`; `036_forecaster_drivers.sql` adds `forecaster_drivers`/`forecaster_driver_values`; `037_forecaster_headcount.sql` adds `forecaster_headcount_roles`; `038_forecaster_forecast_lines.sql` adds `forecaster_forecast_lines`; `039_forecaster_budgets.sql` adds `forecaster_budget_versions`/`forecaster_budget_lines`. Six tables across five migrations.

**`forecaster_plans`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `name` TEXT NOT NULL, non-blank, `<= 120` chars · `description` TEXT NULL, `<= 1000` chars · `starts_on` DATE NOT NULL, CHECK `EXTRACT(DAY FROM starts_on) = 1` · `horizon_months` INT NOT NULL, CHECK `1..60` · `actuals_through` DATE NOT NULL, same first-of-month CHECK · `status` TEXT NOT NULL DEFAULT `'DRAFT'`, CHECK IN (`DRAFT`,`ACTIVE`,`ARCHIVED`) — no terminal state, the identical ruling `fpa_models` carries · `created_by` FK → `users` ON DELETE RESTRICT · `created_at`/`updated_at`. `ux_forecaster_plans_name` — `UNIQUE (org_id, name)`. `ux_forecaster_plans_org_id_id` — the composite target every child table references. `chk_forecaster_plans_actuals_before_start` — CHECK `actuals_through < starts_on`.

**`forecaster_drivers`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `plan_id` UUID NOT NULL, composite FK → `forecaster_plans (org_id, id)` ON DELETE CASCADE · `name` TEXT NOT NULL, non-blank, `<= 120` chars · `unit_label` TEXT NOT NULL DEFAULT `''`, `<= 40` chars · `kind` TEXT NOT NULL, CHECK IN (`COUNT`,`CENTS`,`BPS`) · `created_at`/`updated_at`. `ux_forecaster_drivers_name` — `UNIQUE (org_id, plan_id, name)`.

**`forecaster_driver_values`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `driver_id` UUID NOT NULL, composite FK → `forecaster_drivers (org_id, id)` ON DELETE CASCADE · `month` DATE NOT NULL, first-of-month CHECK · `value` BIGINT NOT NULL (**one column for all three kinds** — its unit is decided by the parent driver's `kind`; `value >= 0` for `COUNT`/`BPS` is enforced by `driverService.setDriverValues` at write time, not a CHECK, because `kind` lives on the parent row) · `created_at`/`updated_at`. `ux_forecaster_driver_values_month` — `UNIQUE (org_id, driver_id, month)`.

**`forecaster_headcount_roles`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `plan_id` UUID NOT NULL, composite FK → `forecaster_plans (org_id, id)` ON DELETE CASCADE · `title` TEXT NOT NULL, non-blank, `<= 120` chars · `department` TEXT NULL, `<= 120` chars · `account_id` UUID NOT NULL (**no `REFERENCES`** — see below) · `starts_on` DATE NOT NULL, first-of-month CHECK · `ends_on` DATE NULL, same CHECK when present · `fte_count` INT NOT NULL DEFAULT `1`, CHECK `1..1000` · `annual_salary_cents` BIGINT NOT NULL, CHECK `>= 0` (**unlike** `fpa_assumptions.fixed_cents`, deliberately non-negative — both this and `fte_count` are passed to `scaleCents` as a numerator, which rejects a negative one) · `loading_bps` INT NOT NULL DEFAULT `0`, CHECK `0..10000` · `created_at`/`updated_at`. `chk_forecaster_headcount_end_after_start` — CHECK `ends_on IS NULL OR ends_on >= starts_on`.

**`forecaster_forecast_lines`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `plan_id` UUID NOT NULL, composite FK → `forecaster_plans (org_id, id)` ON DELETE CASCADE · `account_id` UUID NOT NULL (**no `REFERENCES`**) · `label` TEXT NOT NULL, non-blank, `<= 120` chars · `kind` TEXT NOT NULL, CHECK IN (`DRIVER_PRODUCT`,`DRIVER_PERCENT`,`FIXED_CENTS`) · `quantity_driver_id`/`rate_driver_id`/`source_driver_id` UUID NULL, each a composite FK → `forecaster_drivers (org_id, id)` ON DELETE RESTRICT · `percent_bps` INT NULL, CHECK `0..100000` · `fixed_cents` BIGINT NULL · `created_at`/`updated_at`. `ux_forecaster_lines_label` — `UNIQUE (org_id, plan_id, label)`. **`chk_forecaster_lines_kind_payload`** — a discriminated union: the column(s) the `kind` names are `NOT NULL`, every other driver/payload column is `NULL`.

**The three driver FKs on `forecaster_forecast_lines` are nullable composite FKs, relying on `MATCH SIMPLE`.** PostgreSQL's default skips a composite FK check entirely when any column of the key is `NULL` — since `org_id` is never `NULL` and exactly one of the three driver ids is populated per `kind`, each FK is enforced exactly on the kind that uses it and silently skipped on the kinds that do not. Each is `ON DELETE RESTRICT`, not `CASCADE`: deleting a driver a line depends on fails loudly (`23503`, surfaced by `driverService.deleteDriver` as a `409`), never silently zeroing out a forecast.

**`forecaster_budget_versions`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `plan_id` UUID NOT NULL, composite FK → `forecaster_plans (org_id, id)` ON DELETE CASCADE · `label` TEXT NOT NULL, non-blank, `<= 120` chars · `status` TEXT NOT NULL DEFAULT `'DRAFT'`, CHECK IN (`DRAFT`,`APPROVED`,`SUPERSEDED`) · `created_by` FK → `users` ON DELETE RESTRICT · `approved_by` FK → `users` ON DELETE RESTRICT, NULL · `approved_at` TIMESTAMPTZ NULL · `created_at`/`updated_at`. `ux_forecaster_budget_versions_label` — `UNIQUE (org_id, plan_id, label)`. `chk_forecaster_budget_versions_approval` — CHECK: `DRAFT` has both `approved_by`/`approved_at` `NULL`; anything else has both `NOT NULL`. **`ux_forecaster_budget_versions_one_approved`** — a **partial unique index** `ON forecaster_budget_versions (org_id, plan_id) WHERE status = 'APPROVED'`, the same technique `ux_fpa_scenarios_one_default` and `ux_migration_imports_one_committed_opening` use, proving at most one approved version per plan at the database level.

**`forecaster_budget_lines`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `version_id` UUID NOT NULL, composite FK → `forecaster_budget_versions (org_id, id)` ON DELETE CASCADE · `account_id` UUID NOT NULL (**no `REFERENCES`**) · `month` DATE NOT NULL, first-of-month CHECK · `amount_cents` BIGINT NOT NULL · `source` TEXT NOT NULL, CHECK IN (`DRIVER`,`HEADCOUNT`,`MANUAL`) · `justification` TEXT NOT NULL, non-blank, `<= 1000` chars — **zero-based budgeting enforced by the database, not only the service**. `ux_forecaster_budget_lines_slot` — `UNIQUE (org_id, version_id, account_id, month, source)`, the conflict target `budgetService.compileVersion`'s upserts hit.

**Why `account_id` carries no `REFERENCES` on three of these tables** (`forecaster_headcount_roles`, `forecaster_forecast_lines`, `forecaster_budget_lines`) — the identical ruling migrations 032 (`ap_flow_line_items.account_id`) and 034 (`fpa_assumptions.account_id`) already carry: rules 8 and 16 collide, and 16 wins. Validity is enforced at the service layer via `accountService.getAccountById`'s own cross-tenant `404`, safe because accounts are retired via `is_active = false` and never actually deleted.

**`forecaster_budget_versions`/`forecaster_budget_lines` are this app's ONLY immutable tables, and `SUPERSEDED` is its only terminal FSM state.** `forecaster_plans`, `forecaster_drivers`, `forecaster_driver_values`, `forecaster_headcount_roles` and `forecaster_forecast_lines` carry no immutability trigger at all — the identical ruling `fpa_models`/`fpa_scenarios` carry, since none of them ever reaches the general ledger. A budget version is the deliberate exception: `reject_forecaster_budget_version_mutation()` freezes a version once it leaves `DRAFT`, with one carve-out (`APPROVED → SUPERSEDED`, a `to_jsonb` row-diff comparison mirroring migration 009's `ISSUED → VOID` carve-out for invoices), and `reject_forecaster_frozen_budget_line_mutation()` freezes every line on a non-`DRAFT` version against `INSERT`, `UPDATE` **and** `DELETE`. Not because a budget reaches the GL — it never does — but because an approved budget is a decision of record BoardDeck Automator (Phase 15) will report variance against; rewriting it would rewrite history.

**All six tables are audited** (`audit_row_change('forecaster')`) — every row here is business state a user deliberately sets, not derived output regenerated wholesale, the ruling `bank_match_suggestions`/`ap_flow_pages` carry in the opposite direction.

No new table holds a forecast or a variance report. `GET /plans/:id/forecast` recomputes the whole build-up from `forecaster_driver_values`, `forecaster_forecast_lines` and `forecaster_headcount_roles` on every request; `GET /plans/:id/variance` recomputes from `forecaster_budget_lines` plus `reportService.monthlyActualsByAccount` on every request — the same "no summary table" discipline `reportService`'s own header states. The one deliberate exception is `budgetService.compileVersion`, which **does** materialize the build-up into `forecaster_budget_lines` rows — an approved budget must not silently change when a driver value is edited afterward.

See [api.md](api.md#forecasterpro--apiv1forecaster--phase-13) for the routes and [forecaster.md](forecaster.md) for the full build-up arithmetic and the zero-based-budgeting/approval-freeze rulings.

## Phase 14 — UnitEcon ✅ applied

`040_unitecon_settings.sql` adds `unitecon_settings`/`unitecon_acquisition_accounts`; `041_unitecon_product_lines.sql` adds `unitecon_product_lines`. Three tables across two migrations. **There is no cohort table** — a cohort matrix is derived from `invoices`/`invoice_lines` on every request, never stored; see the "no summary table" note below.

**`unitecon_settings`** — `org_id` UUID **PK**, FK → `organizations` ON DELETE CASCADE (one row per org, not a surrogate `id`) · `gross_margin_bps` INT NOT NULL DEFAULT `7000`, CHECK `0..10000` · `created_by` FK → `users` ON DELETE RESTRICT, NULL · `created_at`/`updated_at`. No row is written until the first `PATCH` — `settingsService.getSettings` returns the default in code rather than seeding a row on read.

**`unitecon_acquisition_accounts`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `account_id` UUID NOT NULL (**no `REFERENCES`** — see below) · `created_at`. `ux_unitecon_acquisition_accounts` — `UNIQUE (org_id, account_id)`, so the same LedgerCore account may be configured once per org.

**`unitecon_product_lines`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `revenue_account_id` UUID NOT NULL (**no `REFERENCES`**) · `name` TEXT NOT NULL, non-blank, `<= 120` chars · `unit_label` TEXT NOT NULL DEFAULT `''`, `<= 40` chars · `is_active` BOOLEAN NOT NULL DEFAULT `true` · `created_by` FK → `users` ON DELETE RESTRICT, NULL · `created_at`/`updated_at`. `ux_unitecon_product_lines_account` — `UNIQUE (org_id, revenue_account_id)`: one product line per revenue account, so PVM never double-counts a unit. `ux_unitecon_product_lines_name` — `UNIQUE (org_id, name)`.

**Why `account_id`/`revenue_account_id` carry no `REFERENCES`** — the identical ruling migrations 032, 034, 037, 038, 039 already carry: rules 8 and 16 collide, and 16 wins. Validity is enforced at the service layer via `accountService.getAccountById`'s own cross-tenant `404`. The product dimension IS the revenue account — UnitEcon does not classify `invoice_lines.description`, which is free text and not a key; PVM decomposes at revenue-account grain and no finer.

**No table in this phase carries an immutability trigger.** UnitEcon posts nothing to the general ledger, so rule 6 does not apply — `PATCH`/`DELETE` on `unitecon_settings` and `unitecon_product_lines` are correct, the identical ruling `fpa_models` and `forecaster_plans` carry. `unitecon_acquisition_accounts` has no `PATCH` route at all (its set is replaced wholesale by `PATCH /unitecon/settings`), so it needs no `updated_at` trigger either. All three tables **are** audited (`audit_row_change('unitecon')`).

**No new table holds a cohort matrix, a CAC/LTV figure, or a PVM report.** `GET /unitecon/cohorts`, `GET /unitecon/unit-economics` and `GET /unitecon/pvm` all recompute from `invoices`/`invoice_lines` (via `reportService.customerRevenueByMonth`/`productLineSalesByMonth`) plus this phase's own configuration tables, on every request — the same "no summary table" discipline `reportService`'s own header states, and `forecaster`'s/`fpa-engine`'s for their own apps.

See [api.md](api.md#unitecon--apiv1unitecon--phase-14) for the routes and [unitecon.md](unitecon.md) for the full cohort/CAC/LTV/PVM arithmetic and the LTV-is-observed and PVM-rounding-residual rulings.

## Phase 15 — BoardDeck Automator ✅ applied

`042_boarddeck_close_runs.sql` adds `boarddeck_close_runs`/`boarddeck_close_checks`; `043_boarddeck_decks.sql` adds `boarddeck_decks`. Three tables across two migrations. **There is no report-output table** — a close run's checks and a deck's slide content are both computed on demand from other apps' data; only the run/deck rows and their status are stored.

**`boarddeck_close_runs`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `fiscal_period_id` UUID NOT NULL (**no `REFERENCES`** — see below) · `status` TEXT NOT NULL DEFAULT `'IN_PROGRESS'`, CHECK IN (`IN_PROGRESS`,`READY`,`BLOCKED`,`CLOSED`) · `period_starts_on`/`period_ends_on` DATE NOT NULL · `ran_at` TIMESTAMPTZ NOT NULL DEFAULT `now()` · `ran_by`/`closed_by`/`created_by` FK → `users` ON DELETE RESTRICT, NULL · `closed_at` TIMESTAMPTZ NULL · `created_at`/`updated_at`. `chk_boarddeck_close_runs_closed_stamp` — CHECK: `CLOSED` has both `closed_at`/`closed_by` `NOT NULL`; anything else has both `NULL`. `ux_boarddeck_close_runs_period` — `UNIQUE (org_id, fiscal_period_id)`: one run per period, re-running replaces its check rows in place rather than creating a second run.

**`boarddeck_close_checks`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `run_id` UUID NOT NULL, composite FK → `boarddeck_close_runs (org_id, id)` ON DELETE CASCADE · `kind` TEXT NOT NULL, CHECK IN (`TRIAL_BALANCE_BALANCED`,`NO_DRAFT_INVOICES`,`NO_UNPOSTED_BILLS`,`NO_UNMATCHED_BANK_LINES`,`PERIOD_OPEN`) · `result` TEXT NOT NULL, CHECK IN (`PASS`,`FAIL`) · `detail` TEXT NOT NULL DEFAULT `''`, `<= 400` chars · `observed_count` BIGINT NOT NULL DEFAULT `0` · `created_at`. `ux_boarddeck_close_checks_run_kind` — `UNIQUE (run_id, kind)`: exactly one row per check per run.

**`boarddeck_decks`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `title` TEXT NOT NULL, non-blank, `<= 160` chars · `fiscal_period_id` UUID NOT NULL (**no `REFERENCES`**) · `plan_id` UUID NULL (**no `REFERENCES`**) · `period_starts_on`/`period_ends_on` DATE NOT NULL · `status` TEXT NOT NULL DEFAULT `'PENDING'`, CHECK IN (`PENDING`,`GENERATING`,`READY`,`FAILED`) · `sha256` TEXT NULL, CHECK matches `^[0-9a-f]{64}$` when present · `byte_size` BIGINT NULL · `slide_count` INTEGER NULL · `error_message` TEXT NULL, `<= 500` chars · `generated_at` TIMESTAMPTZ NULL · `created_by` FK → `users` ON DELETE RESTRICT, NULL · `created_at`/`updated_at`. `chk_boarddeck_decks_ready_artifact` — CHECK: `READY` has `sha256`/`byte_size`/`slide_count`/`generated_at` all `NOT NULL`; anything else has all four `NULL`. `chk_boarddeck_decks_failed_error` — CHECK: `FAILED` has `error_message` `NOT NULL`; anything else has it `NULL`. **No `UNIQUE (org_id, fiscal_period_id)`** — a period may be re-decked any number of times, and each deck is its own artifact.

**The deck's bytes live in `storageService` (Phase 9.5's `put`/`get`), addressed by `sha256`, exactly as `ap_flow_pages.redacted_sha256` addresses its own blobs — deliberately NOT through the platform `documents`/Document Vault table.** A generated `.pptx` is server-produced trusted output, not an untrusted client upload, and `utils/mimeSniff.ts`'s allowlist (`application/pdf`, `image/png`, `image/jpeg`, `text/csv`) does not include it; widening a security-relevant allowlist for this case was rejected.

**Why `fiscal_period_id`/`plan_id` carry no `REFERENCES`** — the identical ruling migrations 032, 034, 037–041 already carry: rules 8 and 16 collide, and 16 wins. Validity is enforced at the service layer via `fiscalPeriodService.getPeriodById` and `planService.getPlanById`, both of which already 404 a cross-tenant id.

**No table in this phase carries an immutability trigger.** BoardDeck posts nothing to the general ledger, so rule 6 does not apply — the identical ruling `fpa_models`, `forecaster_plans` and `unitecon_product_lines` carry. All three tables **are** audited (`audit_row_change('boarddeck')`); `boarddeck_close_checks` has no `updated_at` trigger (its rows are replaced wholesale by `rerunChecks`, never patched in place).

**No new table holds a computed report or a deck's slide content.** The five close checks are computed from `reportService.closeReadiness` (a new LedgerCore bridge summing `ledger_lines`/`invoices`/`bills`/`bank_transactions` inside a date window) on every `POST`/`rerun`; the BvA summary is computed from `varianceService.planVariance` on every `GET /bva`; a deck's slides are rendered once, at generation time, from both of those plus `reportService.profitAndLoss`/`balanceSheet`, and only the resulting `.pptx` bytes are persisted — the same "no summary table" discipline every other app in this suite follows.

See [api.md](api.md#boarddeck-automator--apiv1boarddeck--phase-15) for the routes.

## Phase 16 — TaxGuard AI ✅ applied

`044_taxguard_pgvector.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` — a database-wide object, its own migration ahead of the tables so a missing extension fails with a named error rather than a confusing "type vector does not exist" on a `CREATE TABLE`. **Requires `docker-compose.yml` to run `pgvector/pgvector:pg16`** — the stock `postgres:16` image does not ship this extension. `045_taxguard_corpus.sql` adds `taxguard_corpus_documents`/`taxguard_chunks`; `046_taxguard_questions.sql` adds `taxguard_questions`. Three tables across three migrations.

**`taxguard_corpus_documents`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `document_id` UUID NOT NULL, composite FK → `documents (org_id, id)` ON DELETE CASCADE (`documents` is a **platform** table, migration 030 — not a rule-16 violation) · `title` TEXT NOT NULL, non-blank, `<= 300` chars · `jurisdiction` TEXT NOT NULL, CHECK IN (`IN`,`US`,`UK`,`CA`,`AU`,`OTHER`) · `act_year` INTEGER NULL, `1800`–`2200` when present · `status` TEXT NOT NULL DEFAULT `'PENDING'`, CHECK IN (`PENDING`,`PARSING`,`EMBEDDING`,`READY`,`FAILED`) · `chunk_count` INTEGER NOT NULL DEFAULT `0` · `error_message` TEXT NULL, `<= 500` chars · `ingested_at` TIMESTAMPTZ NULL · `created_by` FK → `users` ON DELETE RESTRICT, NULL · `created_at`/`updated_at`. `chk_taxguard_corpus_ready` — CHECK: `READY` has `ingested_at` `NOT NULL` and `chunk_count > 0`; anything else has `ingested_at` `NULL`. `chk_taxguard_corpus_failed` — CHECK: `FAILED` has `error_message` `NOT NULL`; anything else has it `NULL`. `ux_taxguard_corpus_document` — `UNIQUE (org_id, document_id)`: one corpus entry per vaulted PDF, so a `FAILED` ingest must be deleted before the same document can be re-added (there is no in-place re-ingest).

**`taxguard_chunks`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `corpus_document_id` UUID NOT NULL, composite FK → `taxguard_corpus_documents (org_id, id)` ON DELETE CASCADE · `ordinal` INTEGER NOT NULL, `>= 0` · `citation` TEXT NOT NULL, non-blank, `<= 200` chars · `heading` TEXT NULL, `<= 300` chars · `content` TEXT NOT NULL, non-blank · `token_estimate` INTEGER NOT NULL, `> 0` · `embedding` `vector(1024)` NULL · `embedded_at` TIMESTAMPTZ NULL · `created_at`. `chk_taxguard_chunks_embedded` — CHECK: `embedding` and `embedded_at` are both `NULL` or both `NOT NULL`, never one without the other. `ux_taxguard_chunks_ordinal` — `UNIQUE (org_id, corpus_document_id, ordinal)`. An HNSW index (`vector_cosine_ops`) backs similarity search; it is **unfiltered by `org_id`** — pgvector has no native per-tenant partial ANN index, so `retrievalService`'s query applies `org_id` as a `WHERE` predicate and pgvector post-filters the ANN candidate set. Acceptable at this project's portfolio scale; noted rather than hidden. **No audit trigger** — one ingest can produce thousands of chunk rows for a single user action, and the parent corpus document's own audit trail (status transitions, `chunk_count`) is the record.

**`taxguard_questions`** — `id` UUID PK · `org_id` FK → `organizations` ON DELETE CASCADE · `question_text` TEXT NOT NULL, non-blank, `<= 2000` chars (the asker's own raw text, stored for their history) · `redacted_question` TEXT NOT NULL, non-blank (what was actually sent to the embeddings/answer providers) · `jurisdiction` TEXT NOT NULL, CHECK IN (`IN`,`US`,`UK`,`CA`,`AU`,`OTHER`) · `answer_text` TEXT NOT NULL, non-blank · `citations` JSONB NOT NULL DEFAULT `'[]'`, CHECK `jsonb_typeof = 'array'` · `model` TEXT NOT NULL, non-blank, `<= 100` chars · `retrieved_chunk_ids` `UUID[]` NOT NULL DEFAULT `'{}'` (**no FK** — deliberate; a chunk may be deleted by a later re-ingest and the historical answer must survive unchanged, the identical "link outliving its entity" ruling `document_links.entity_id` carries) · `latency_ms` INTEGER NOT NULL, `>= 0` · `created_by` FK → `users` ON DELETE RESTRICT, NULL · `created_at`. No status column and no `updated_at` trigger — a question row is written once, after the answer already exists.

**Embedding dimension is fixed at 1024** (`voyage-3.5`, Voyage AI) in the column type itself. Changing it is a new migration plus a full re-embed of every chunk, not a value to tune casually.

**No money column anywhere in this phase.** TaxGuard posts nothing to the general ledger and has no `*_cents` field.

**No table in this phase carries an immutability trigger.** TaxGuard posts nothing to the general ledger, so rule 6 does not apply — the identical ruling `fpa_models`, `forecaster_plans`, `unitecon_product_lines` and `boarddeck_decks` each carry. `taxguard_corpus_documents` and `taxguard_questions` **are** audited (`audit_row_change('taxguard')`); `taxguard_chunks` is not, for the volume reason above.

See [api.md](api.md#taxguard-ai--apiv1taxguard--phase-16) for the routes.

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

Codes are chosen to match the worked examples in [ledger-core.md](ledger-core.md) and [ap-flow.md](ap-flow.md) literally — `6120 Software & IT Infrastructure` debited against `2100 Accounts Payable` for a cloud bill, `1500 Fixed Assets / Equipment` against `1110 Operating Cash` for a hardware receipt, and a supermarket receipt split across `6130` and `6140`.
