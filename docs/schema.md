# Database Schema

**No migrations exist yet.** Everything below is the target. Keep this file verified against `server/src/db/migrations/`.

Migrations live in `server/src/db/migrations/` **only**, applied in sorted filename order.

## Migration rules

- Strict sequential 3-digit prefix, descriptive suffix: `001_organizations_and_users.sql`, `002_general_ledger.sql`. No gaps, no branches.
- **Additive and idempotent.** Use `IF NOT EXISTS` / `IF EXISTS`. **Never edit an applied migration** — write a new one.
- Data-destructive changes (dropping a column, narrowing a type) require explicit sign-off before being written.
- Money columns are `BIGINT` cents. No `DECIMAL` money, ever.
- `org_id UUID NOT NULL REFERENCES organizations(id)` on every domain table.
- Every FK declared with an explicit `ON DELETE`.
- Index every scope column and every FK used in a join.
- Reuse the shared `set_updated_at()` trigger function rather than defining another.

---

## Phase 1 — Identity & tenancy

**`organizations`** — the tenant boundary
`id` UUID PK · `name` TEXT NOT NULL · `slug` TEXT UNIQUE · `base_currency` CHAR(3) NOT NULL DEFAULT `'USD'` · `created_at` · `updated_at`

**`users`** — global identity, no `org_id`
`id` UUID PK · `name` TEXT · `email` TEXT NOT NULL · `password` TEXT NOT NULL (bcrypt) · `email_verified` BOOLEAN DEFAULT false · `email_verification_token` TEXT · `email_verification_token_expires` TIMESTAMPTZ · `created_at` · `updated_at`
Constraint: `UNIQUE (LOWER(email))` via functional unique index.

**`organization_members`** — membership + role
`id` UUID PK · `org_id` UUID NOT NULL FK → `organizations` ON DELETE CASCADE · `user_id` UUID NOT NULL FK → `users` ON DELETE CASCADE · `role` TEXT NOT NULL CHECK IN (`OWNER`,`ADMIN`,`ACCOUNTANT`,`VIEWER`) · `created_at`
Constraint: `UNIQUE (org_id, user_id)`. Index on `user_id`.

**`refresh_tokens`**
`id` UUID PK · `user_id` UUID NOT NULL FK → `users` ON DELETE CASCADE · `token` TEXT UNIQUE NOT NULL · `expires_at` TIMESTAMPTZ NOT NULL · `created_at`

---

## Phase 2 — General Ledger

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

Seeded per **organization** at registration, inside the same transaction that creates the org. Code ranges:

| Range | Type |
|---|---|
| 1000–1999 | Assets |
| 2000–2999 | Liabilities |
| 3000–3999 | Equity |
| 4000–4999 | Revenue |
| 5000–6999 | Expenses |

Reports rely on the numbering convention — keep the ranges intact when extending the seed. The seed belongs in a service (`accountService.seedDefaultChart`), not inlined in a controller.
