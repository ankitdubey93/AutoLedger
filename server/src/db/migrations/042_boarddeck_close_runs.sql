-- 042_boarddeck_close_runs.sql
-- Phase 15 — BoardDeck Automator: monthly close automation. See
-- docs/roadmap.md#phase-15.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- A close run is a snapshot of five readiness checks against a LedgerCore
-- fiscal period, computed on demand and stored so the checklist and its
-- outcome are auditable after the fact. One run per period — re-running
-- replaces its check rows in place rather than creating a second run.
--
-- No REFERENCES fiscal_periods on boarddeck_close_runs.fiscal_period_id —
-- rules 8 and 16 collide, 16 wins, the identical ruling migrations 032, 034,
-- 037, 038, 039, 040 and 041 already carry. closeRunService validates the id
-- through fiscalPeriodService.getPeriodById.
--
-- No immutability trigger on either table — nothing in this phase ever
-- reaches the general ledger, the identical ruling fpa_models,
-- forecaster_plans and unitecon_product_lines each carry.

CREATE TABLE IF NOT EXISTS boarddeck_close_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- No REFERENCES fiscal_periods — see this file's header.
  fiscal_period_id  UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                    CHECK (status IN ('IN_PROGRESS', 'READY', 'BLOCKED', 'CLOSED')),
  period_starts_on  DATE NOT NULL,
  period_ends_on    DATE NOT NULL,
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ran_by            UUID REFERENCES users(id) ON DELETE RESTRICT,
  closed_at         TIMESTAMPTZ,
  closed_by         UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_by        UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_boarddeck_close_runs_period CHECK (period_ends_on >= period_starts_on),
  -- CLOSED is the only status that may carry the close stamp, and it must.
  CONSTRAINT chk_boarddeck_close_runs_closed_stamp CHECK (
    (status =  'CLOSED' AND closed_at IS NOT NULL AND closed_by IS NOT NULL) OR
    (status <> 'CLOSED' AND closed_at IS NULL     AND closed_by IS NULL)
  ),
  -- One run per period: re-running replaces the check rows in place.
  CONSTRAINT ux_boarddeck_close_runs_period UNIQUE (org_id, fiscal_period_id),
  CONSTRAINT ux_boarddeck_close_runs_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_boarddeck_close_runs_org_ran
  ON boarddeck_close_runs (org_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_boarddeck_close_runs_ran_by ON boarddeck_close_runs (ran_by);
CREATE INDEX IF NOT EXISTS idx_boarddeck_close_runs_closed_by ON boarddeck_close_runs (closed_by);
CREATE INDEX IF NOT EXISTS idx_boarddeck_close_runs_created_by ON boarddeck_close_runs (created_by);

CREATE TABLE IF NOT EXISTS boarddeck_close_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'TRIAL_BALANCE_BALANCED', 'NO_DRAFT_INVOICES', 'NO_UNPOSTED_BILLS',
                    'NO_UNMATCHED_BANK_LINES', 'PERIOD_OPEN')),
  result          TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL')),
  detail          TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 400),
  observed_count  BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK: a check row can never point at another tenant's run.
  CONSTRAINT fk_boarddeck_close_checks_run
    FOREIGN KEY (org_id, run_id) REFERENCES boarddeck_close_runs (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_boarddeck_close_checks_run_kind UNIQUE (run_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_boarddeck_close_checks_org_run
  ON boarddeck_close_checks (org_id, run_id);

CREATE OR REPLACE TRIGGER trg_boarddeck_close_runs_updated
  BEFORE UPDATE ON boarddeck_close_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_boarddeck_close_runs_audit
  AFTER INSERT OR UPDATE OR DELETE ON boarddeck_close_runs
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('boarddeck');
CREATE OR REPLACE TRIGGER trg_boarddeck_close_checks_audit
  AFTER INSERT OR UPDATE OR DELETE ON boarddeck_close_checks
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('boarddeck');
