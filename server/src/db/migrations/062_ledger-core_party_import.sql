-- 062_ledger-core_party_import.sql
-- Phase 20 — extends the Phase 9 staged migration importer with two new
-- kinds, CUSTOMERS and VENDORS, rather than building a second import
-- pipeline. The existing per-row staging, per-row fixes, preview and
-- all-or-nothing commit all carry over unchanged.
--
-- Widens migration_imports.kind. 029 declared the CHECK inline, so Postgres
-- named it migration_imports_kind_check. Replacing a constraint in a NEW
-- migration is legal; editing 029 is not (rule 13). Widening a CHECK is not
-- destructive — no existing row can violate the larger set.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

ALTER TABLE migration_imports DROP CONSTRAINT IF EXISTS migration_imports_kind_check;
ALTER TABLE migration_imports DROP CONSTRAINT IF EXISTS chk_migration_imports_kind;
ALTER TABLE migration_imports ADD CONSTRAINT chk_migration_imports_kind
  CHECK (kind IN ('CHART_OF_ACCOUNTS', 'OPENING_BALANCES', 'CUSTOMERS', 'VENDORS'));

-- A customer/vendor row is name-shaped, not account-shaped — these seven
-- columns hold the parsed CSV cell for each field a party record can carry.
ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS party_name          TEXT;
ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS party_email         TEXT;
ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS party_phone         TEXT;
ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS party_address       TEXT;
ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS party_tax_number    TEXT;
ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS party_payment_terms TEXT;
ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS party_notes         TEXT;
