-- 029_ledger-core_migration_imports.sql
-- Phase 9b — staged chart-of-accounts and opening-balance import. See
-- docs/roadmap.md#phase-9-planned-scope and docs/ledger-core.md.
--
-- Two tables: one row per staged import (migration_imports), one row per
-- parsed CSV row within it (migration_import_rows). DELIBERATELY SHAPED
-- AGAINST Phase 6's bank import: that one aborts the entire file on any bad
-- row and writes live rows immediately. This one stages every row, good and
-- bad, and separates validation from commit, because a partially-wrong chart
-- is normal on a first export and re-uploading to discover the next error
-- one at a time is a bad workflow.

CREATE TABLE IF NOT EXISTS migration_imports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  kind             TEXT NOT NULL CHECK (kind IN ('CHART_OF_ACCOUNTS', 'OPENING_BALANCES')),
  status           TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'VALIDATED', 'COMMITTED')),
  file_name        TEXT NOT NULL CHECK (length(btrim(file_name)) > 0 AND length(file_name) <= 200),
  delimiter        TEXT NOT NULL CHECK (length(delimiter) = 1),
  row_count        INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  error_count      INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  journal_entry_id UUID,
  committed_at     TIMESTAMPTZ,
  created_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_migration_imports_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_migration_imports_error_count CHECK (error_count <= row_count),
  CONSTRAINT chk_migration_imports_committed CHECK (
    (status = 'COMMITTED') = (committed_at IS NOT NULL)
  ),
  CONSTRAINT chk_migration_imports_entry_kind CHECK (
    journal_entry_id IS NULL OR kind = 'OPENING_BALANCES'
  ),
  CONSTRAINT fk_migration_imports_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_migration_imports_org_created
  ON migration_imports (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_migration_imports_created_by ON migration_imports (created_by);
CREATE INDEX IF NOT EXISTS idx_migration_imports_entry ON migration_imports (journal_entry_id);

-- One committed opening-balance import per organization, ever. A partial
-- unique index, not a service check: the service check has a race, and a
-- second set of opening balances would silently double the books. A wrong
-- import is corrected by a reversing journal entry (rule 6), never by
-- re-importing. A CHART_OF_ACCOUNTS import may be committed any number of
-- times — merging a chart repeatedly is harmless.
CREATE UNIQUE INDEX IF NOT EXISTS ux_migration_imports_one_committed_opening
  ON migration_imports (org_id)
  WHERE kind = 'OPENING_BALANCES' AND status = 'COMMITTED';

CREATE TABLE IF NOT EXISTS migration_import_rows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  import_id     UUID NOT NULL,
  row_number    INTEGER NOT NULL CHECK (row_number >= 2),
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,

  account_code  TEXT CHECK (account_code IS NULL OR length(account_code) <= 20),
  account_name  TEXT CHECK (account_name IS NULL OR length(account_name) <= 120),
  account_type  TEXT CHECK (account_type IS NULL
                  OR account_type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense')),
  parent_code   TEXT CHECK (parent_code IS NULL OR length(parent_code) <= 20),
  description   TEXT CHECK (description IS NULL OR length(description) <= 500),
  debit_cents   BIGINT CHECK (debit_cents IS NULL OR debit_cents >= 0),
  credit_cents  BIGINT CHECK (credit_cents IS NULL OR credit_cents >= 0),

  errors        TEXT[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'INVALID'
                CHECK (status IN ('VALID', 'INVALID', 'EXCLUDED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_migration_rows_import_row UNIQUE (org_id, import_id, row_number),
  -- Rule 7's shape, applied to staged data: at most one side may be non-zero.
  CONSTRAINT chk_migration_rows_one_side CHECK (
    debit_cents IS NULL OR credit_cents IS NULL
    OR debit_cents = 0 OR credit_cents = 0
  ),
  CONSTRAINT chk_migration_rows_valid_has_no_errors CHECK (
    status <> 'VALID' OR cardinality(errors) = 0
  ),
  CONSTRAINT fk_migration_rows_import
    FOREIGN KEY (org_id, import_id) REFERENCES migration_imports (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_migration_rows_import
  ON migration_import_rows (org_id, import_id, row_number);
CREATE INDEX IF NOT EXISTS idx_migration_rows_status
  ON migration_import_rows (org_id, import_id, status);

CREATE OR REPLACE TRIGGER trg_migration_imports_updated_at
  BEFORE UPDATE ON migration_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_migration_rows_updated_at
  BEFORE UPDATE ON migration_import_rows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Phase 5's audit_row_change() on the PARENT only. migration_import_rows is
-- staging data — it is rewritten wholesale on every re-validate, and what it
-- ultimately produces (accounts, one journal entry) is itself audited. This
-- is the same exemption bank_match_suggestions (019) and fx_revaluation_lines
-- (026) carry, for the same reason.
CREATE OR REPLACE TRIGGER trg_migration_imports_audit
  AFTER INSERT OR UPDATE OR DELETE ON migration_imports
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
