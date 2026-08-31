# Database Schema

**Applied: `001_organizations_and_users.sql`.** Phase 3 onward is still the target. Keep this file verified against `server/src/db/migrations/`.

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
`id` UUID PK DEFAULT `gen_random_uuid()` · `name` TEXT NOT NULL CHECK non-blank · `slug` TEXT UNIQUE NOT NULL · `base_currency` CHAR(3) NOT NULL DEFAULT `'USD'` CHECK `~ '^[A-Z]{3}$'` · `created_at` · `updated_at`

The currency CHECK is not decoration: `CHAR(3)` alone accepts `'usd'`, `'123'` and `'   '`.

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

## Phase 3 — General Ledger (LedgerCore)

**`accounts`** — chart of accounts, per organization
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` · `code` TEXT NOT NULL · `name` TEXT NOT NULL · `type` TEXT NOT NULL CHECK IN (`Asset`,`Liability`,`Equity`,`Revenue`,`Expense`) · `description` TEXT · `is_active` BOOLEAN DEFAULT true · `created_at` · `updated_at`
Constraint: `UNIQUE (org_id, code)`.

**`journal_entries`** — transaction headers
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` · `created_by` UUID NOT NULL FK → `users` · `entry_date` DATE NOT NULL · `description` TEXT · `source_type` TEXT NOT NULL DEFAULT `'manual'` · `source_id` UUID · `reverses_entry_id` UUID FK → `journal_entries` · `created_at` · `updated_at`

`source_type` / `source_id` are the hook every future module uses to link its own documents to the GL. `reverses_entry_id` links a reversing entry to its original.
Index on `(org_id, entry_date)` and `(org_id, source_type, source_id)`.

**`ledger_lines`** — atomic debits/credits
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` · `journal_entry_id` UUID NOT NULL FK → `journal_entries` ON DELETE CASCADE · `account_id` UUID NOT NULL FK → `accounts` · `debit_cents` BIGINT NOT NULL DEFAULT 0 CHECK (`debit_cents >= 0`) · `credit_cents` BIGINT NOT NULL DEFAULT 0 CHECK (`credit_cents >= 0`)

Constraints:
- `chk_line_nonzero` — NOT (`debit_cents = 0` AND `credit_cents = 0`)
- `chk_exclusive_debit_credit` — NOT (`debit_cents > 0` AND `credit_cents > 0`)

Index on `(org_id, account_id)` and `journal_entry_id`.

---

## Conventions

### Account types

Exactly five, forever: `Asset`, `Liability`, `Equity`, `Revenue`, `Expense`. Do not add a sixth.

### Default chart of accounts

**Not seeded yet — this begins in Phase 3.** `accounts` does not exist, so `/auth/register` still creates only the user, the organization and the OWNER membership.

**Phase 3 therefore owes a backfill.** Every organization registered during Phases 1–2 has zero accounts, so adding the seed to `register` is not sufficient on its own — Phase 3 needs either a data migration for existing organizations or an idempotent seed-on-first-access. Recorded in [roadmap.md](roadmap.md).

From Phase 3, seeded per **organization** at registration, inside the same transaction that creates the org. Code ranges:

| Range | Type |
|---|---|
| 1000–1999 | Assets |
| 2000–2999 | Liabilities |
| 3000–3999 | Equity |
| 4000–4999 | Revenue |
| 5000–6999 | Expenses |

Reports rely on the numbering convention — keep the ranges intact when extending the seed. The seed belongs in a service (`accountService.seedDefaultChart`), not inlined in a controller.
