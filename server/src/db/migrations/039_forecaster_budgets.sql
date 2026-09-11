-- 039_forecaster_budgets.sql
-- Phase 13 — ForecasterPro: zero-based budget versions and lines. See
-- docs/forecaster.md and docs/roadmap.md#phase-13.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- Two tables. forecaster_budget_versions is a compiled or hand-built budget
-- on a plan; forecaster_budget_lines is one line per (account, month,
-- source) within a version. `compileVersion` materializes the forecast
-- build-up (migration 038) into DRIVER/HEADCOUNT lines while preserving any
-- hand-entered MANUAL lines; `approveVersion` freezes the version once and
-- supersedes any prior approved version.
--
-- THIS IS FORECASTERPRO'S ONLY IMMUTABILITY TRIGGER, AND SUPERSEDED ITS
-- ONLY TERMINAL STATE. Not because a budget reaches the general ledger — it
-- never does, ForecasterPro posts nothing to the GL, ever — but because an
-- approved budget is a decision of record that BoardDeck (Phase 15) will
-- report variance against; rewriting it would rewrite history. Every other
-- forecaster_* table is freely mutable (migration 035's ruling for
-- forecaster_plans, which this table deliberately contrasts with).
--
-- No REFERENCES accounts on forecaster_budget_lines.account_id — rules 8
-- and 16 collide, 16 wins, the identical ruling migrations 032, 034, 037
-- and 038 already carry.
--
-- Zero-based budgeting: every line must justify itself. A blank
-- justification is rejected by the database, not only by the service.

CREATE TABLE IF NOT EXISTS forecaster_budget_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id     UUID NOT NULL,
  label       TEXT NOT NULL CHECK (length(btrim(label)) > 0 AND length(label) <= 120),
  status      TEXT NOT NULL DEFAULT 'DRAFT'
              CHECK (status IN ('DRAFT','APPROVED','SUPERSEDED')),
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_forecaster_budget_versions_plan
    FOREIGN KEY (org_id, plan_id) REFERENCES forecaster_plans (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_forecaster_budget_versions_label  UNIQUE (org_id, plan_id, label),
  CONSTRAINT ux_forecaster_budget_versions_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_forecaster_budget_versions_approval CHECK (
    (status = 'DRAFT' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status <> 'DRAFT' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

-- At most one APPROVED version per plan, at the database level — the same
-- technique migration 029's ux_migration_imports_one_committed_opening uses
-- and migration 033's ux_fpa_scenarios_one_default uses.
CREATE UNIQUE INDEX IF NOT EXISTS ux_forecaster_budget_versions_one_approved
  ON forecaster_budget_versions (org_id, plan_id) WHERE status = 'APPROVED';

CREATE INDEX IF NOT EXISTS idx_forecaster_budget_versions_plan
  ON forecaster_budget_versions (org_id, plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecaster_budget_versions_created_by
  ON forecaster_budget_versions (created_by);
CREATE INDEX IF NOT EXISTS idx_forecaster_budget_versions_approved_by
  ON forecaster_budget_versions (approved_by);

CREATE TABLE IF NOT EXISTS forecaster_budget_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version_id    UUID NOT NULL,
  -- No REFERENCES accounts — rules 8 and 16 collide, 16 wins.
  account_id    UUID NOT NULL,
  month         DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  amount_cents  BIGINT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('DRIVER','HEADCOUNT','MANUAL')),
  -- Zero-based budgeting: every line must justify itself. A blank
  -- justification is rejected by the database, not only by the service.
  justification TEXT NOT NULL CHECK (length(btrim(justification)) > 0
                                     AND length(justification) <= 1000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_forecaster_budget_lines_version
    FOREIGN KEY (org_id, version_id) REFERENCES forecaster_budget_versions (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_forecaster_budget_lines_slot
    UNIQUE (org_id, version_id, account_id, month, source)
);

CREATE INDEX IF NOT EXISTS idx_forecaster_budget_lines_version
  ON forecaster_budget_lines (org_id, version_id, month, account_id);

-- A version that has left DRAFT is frozen, with one carve-out: the status
-- may still move (APPROVED -> SUPERSEDED), which is what lets a newer
-- version take over without ever violating ux_..._one_approved. A
-- to_jsonb row-diff carve-out, the identical technique migration 009 uses
-- for an invoice's ISSUED -> VOID edge.
CREATE OR REPLACE FUNCTION reject_forecaster_budget_version_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED'
     AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Budget version % has left DRAFT and is immutable', OLD.id
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_forecaster_budget_versions_freeze_guard
  BEFORE UPDATE ON forecaster_budget_versions
  FOR EACH ROW EXECUTE FUNCTION reject_forecaster_budget_version_mutation();

-- A budget line may only be inserted, changed or removed while its parent
-- version is still DRAFT. A NULL status means the parent is already gone
-- (ON DELETE CASCADE), so that case passes through rather than raising —
-- mirroring reject_ap_flow_posted_line_item_mutation() exactly.
CREATE OR REPLACE FUNCTION reject_forecaster_frozen_budget_line_mutation() RETURNS TRIGGER AS $$
DECLARE
  v_version_id UUID;
  v_status     TEXT;
BEGIN
  v_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT status INTO v_status FROM forecaster_budget_versions WHERE id = v_version_id;

  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Budget version % has left DRAFT — its lines cannot be changed', v_version_id
      USING ERRCODE = '0A000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_forecaster_budget_lines_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON forecaster_budget_lines
  FOR EACH ROW EXECUTE FUNCTION reject_forecaster_frozen_budget_line_mutation();

-- Trigger name ordering matters: same-timing BEFORE UPDATE row triggers
-- fire in name order, and trg_forecaster_budget_versions_freeze_guard sorts
-- before trg_forecaster_budget_versions_updated, so the guard sees
-- NEW.updated_at exactly as the service wrote it — the identical discipline
-- migration 032's comment records.
CREATE OR REPLACE TRIGGER trg_forecaster_budget_versions_updated
  BEFORE UPDATE ON forecaster_budget_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_forecaster_budget_versions_audit
  AFTER INSERT OR UPDATE OR DELETE ON forecaster_budget_versions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('forecaster');

CREATE OR REPLACE TRIGGER trg_forecaster_budget_lines_updated
  BEFORE UPDATE ON forecaster_budget_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_forecaster_budget_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON forecaster_budget_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('forecaster');
