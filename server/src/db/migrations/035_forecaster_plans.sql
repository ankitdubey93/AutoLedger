-- 035_forecaster_plans.sql
-- Phase 13 — ForecasterPro: forecast plans. See docs/forecaster.md and
-- docs/roadmap.md#phase-13.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- One table: forecaster_plans, a named forecast container — a start month,
-- a horizon in months, and the month through which actuals are considered
-- final. Drivers (036), headcount roles (037), forecast lines (038) and
-- budget versions (039) all hang off a plan.
--
-- Three deliberate rulings, cited here so they are not re-argued elsewhere:
--
-- (a) NO IMMUTABILITY TRIGGER, AND status HAS NO TERMINAL STATE.
-- ForecasterPro posts nothing to the general ledger, ever — a plan is a
-- container for driver-based arithmetic, never a source document. Rule 6
-- ("posted financial documents are immutable") therefore does not apply,
-- and PATCH/DELETE on a plan are correct, not a violation — the identical
-- ruling migration 033 records for fpa_models. A budget version (migration
-- 039) is ForecasterPro's one exception, and its own header explains why.
-- forecaster_plans.status cycles DRAFT <-> ACTIVE <-> ARCHIVED with no dead
-- end — see types/forecaster.ts's FORECASTER_PLAN_TRANSITIONS, which this
-- CHECK must keep matching exactly.
--
-- (b) starts_on and actuals_through are constrained to the first of a
-- month. ForecasterPro projects in monthly calendar buckets, not
-- LedgerCore's fiscal periods (015) — a rolling forecast window is not a
-- closeable accounting period, the same ruling migration 033 records for
-- fpa_models.
--
-- (c) The table is audited (trg_forecaster_plans_audit). A plan is
-- business state a user deliberately sets and revisits, not derived output
-- regenerated wholesale on every read.

CREATE TABLE IF NOT EXISTS forecaster_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  description     TEXT NULL CHECK (description IS NULL OR length(description) <= 1000),
  -- Monthly calendar buckets, not fiscal periods — see ruling (b) above.
  starts_on       DATE NOT NULL CHECK (EXTRACT(DAY FROM starts_on) = 1),
  horizon_months  INT  NOT NULL CHECK (horizon_months BETWEEN 1 AND 60),
  actuals_through DATE NOT NULL CHECK (EXTRACT(DAY FROM actuals_through) = 1),
  -- No terminal state — see ruling (a) above. Must match
  -- types/forecaster.ts's FORECASTER_PLAN_STATUSES exactly.
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  created_by      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_forecaster_plans_name      UNIQUE (org_id, name),
  CONSTRAINT ux_forecaster_plans_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_forecaster_plans_actuals_before_start CHECK (actuals_through < starts_on)
);

CREATE INDEX IF NOT EXISTS idx_forecaster_plans_org_status
  ON forecaster_plans (org_id, status, starts_on DESC);
CREATE INDEX IF NOT EXISTS idx_forecaster_plans_created_by ON forecaster_plans (created_by);

CREATE OR REPLACE TRIGGER trg_forecaster_plans_updated
  BEFORE UPDATE ON forecaster_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_forecaster_plans_audit
  AFTER INSERT OR UPDATE OR DELETE ON forecaster_plans
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('forecaster');
