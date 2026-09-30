-- 078_ledger-core_migration_import_kinds.sql
-- Phase 36a (Step A of the CSV import foundation) — widens the staged
-- importer built in Phase 9b (029) and extended in Phase 20 (062) so
-- Steps B-D (products/inventory items, journals, invoices/bills) can land
-- as service-level additions with no further kind migration of their own.
--
-- 1. The database now admits five more kinds — ITEMS, INVENTORY_ITEMS,
--    INVOICES, BILLS, JOURNALS — ahead of the code that uses them. The
--    TypeScript MIGRATION_IMPORT_KINDS tuple still lists only the four
--    kinds this plan builds; each later step widens the tuple in code when
--    it adds its own kind, matching a CHECK that already allows it.
-- 2. The four legacy kinds (chart of accounts, opening balances, customers,
--    vendors) keep their existing typed columns on migration_import_rows
--    unchanged. The new `data` (JSONB) and `group_key` (TEXT) columns exist
--    for the Step B-D kinds, which stage rows shaped too differently from
--    each other for a fixed set of typed columns to hold.
-- 3. `result` on migration_imports replaces the need for a per-kind foreign
--    id column on the import row (e.g. journal_entry_id for one kind, a
--    created-count for another) — a column whose meaning depends on the
--    row's own kind is a polymorphic association, which rule 8 (every
--    *_id gets a real REFERENCES) forbids modelling as a bare id.
--
-- Every statement is idempotent, and the runner applies the file in a
-- single transaction with PostgreSQL's transactional DDL, so a failure
-- anywhere below leaves the database untouched.

ALTER TABLE migration_imports DROP CONSTRAINT IF EXISTS chk_migration_imports_kind;
ALTER TABLE migration_imports ADD CONSTRAINT chk_migration_imports_kind
  CHECK (kind IN ('CHART_OF_ACCOUNTS', 'OPENING_BALANCES', 'CUSTOMERS', 'VENDORS',
                  'ITEMS', 'INVENTORY_ITEMS', 'INVOICES', 'BILLS', 'JOURNALS'));

ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS column_map JSONB
  CHECK (column_map IS NULL OR jsonb_typeof(column_map) = 'object');
ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(options) = 'object');
ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS commit_options JSONB
  CHECK (commit_options IS NULL OR jsonb_typeof(commit_options) = 'object');
ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS result JSONB
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object');

ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS data JSONB
  CHECK (data IS NULL OR jsonb_typeof(data) = 'object');
ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS group_key TEXT
  CHECK (group_key IS NULL OR length(group_key) <= 220);

CREATE INDEX IF NOT EXISTS idx_migration_rows_group
  ON migration_import_rows (org_id, import_id, group_key) WHERE group_key IS NOT NULL;
