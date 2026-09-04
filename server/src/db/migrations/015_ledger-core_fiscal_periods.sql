-- 015_ledger-core_fiscal_periods.sql
-- Phase 4 — LedgerCore fiscal periods. See docs/schema.md and
-- docs/ledger-core.md#phase-4--live-statements.
--
-- The first CREATE EXTENSION in this project. btree_gist is what lets a
-- GIST exclusion constraint mix a plain-equality column (org_id, a uuid)
-- with an overlap operator on a range — GIST has no built-in uuid opclass.
-- Postgres' docker image runs as a superuser, which this requires.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- 'FY 2026' or 'FY 2026–27', exactly as utils/fiscalYear.ts builds it.
  fiscal_year_label  TEXT NOT NULL CHECK (length(btrim(fiscal_year_label)) > 0),
  period_number      SMALLINT NOT NULL CHECK (period_number BETWEEN 1 AND 12),

  starts_on          DATE NOT NULL,
  ends_on            DATE NOT NULL,

  status             TEXT NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN', 'CLOSED', 'LOCKED')),

  closed_by          UUID REFERENCES users(id) ON DELETE RESTRICT,
  closed_at          TIMESTAMPTZ,
  locked_by          UUID REFERENCES users(id) ON DELETE RESTRICT,
  locked_at          TIMESTAMPTZ,

  created_by         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The composite-FK target convention every LedgerCore table follows, so a
  -- future table referencing a period cannot cross tenants.
  CONSTRAINT ux_fiscal_periods_org_id_id UNIQUE (org_id, id),

  CONSTRAINT chk_fiscal_periods_range CHECK (ends_on >= starts_on),
  CONSTRAINT chk_fiscal_periods_closed_complete CHECK (
    status = 'OPEN' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL)
  ),
  CONSTRAINT chk_fiscal_periods_locked_complete CHECK (
    status <> 'LOCKED' OR (locked_by IS NOT NULL AND locked_at IS NOT NULL)
  ),

  -- Two periods in one organization can never overlap by a single day.
  -- '[]' makes the range inclusive of both endpoints, matching how
  -- starts_on/ends_on are read everywhere else (BETWEEN, inclusive).
  -- A UNIQUE constraint cannot express this: overlap is not equality.
  CONSTRAINT ex_fiscal_periods_no_overlap EXCLUDE USING GIST (
    org_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS idx_fiscal_periods_org_range
  ON fiscal_periods (org_id, starts_on, ends_on);
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_org_status
  ON fiscal_periods (org_id, status);

CREATE OR REPLACE TRIGGER trg_fiscal_periods_updated_at
  BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
