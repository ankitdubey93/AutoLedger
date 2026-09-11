-- 037_forecaster_headcount.sql
-- Phase 13 — ForecasterPro: headcount planning. See docs/forecaster.md and
-- docs/roadmap.md#phase-13.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- One table: forecaster_headcount_roles, a planned role on a plan — title,
-- an optional department label, a start/end month, FTE count, annual
-- salary and a loading rate, mapped to an expense account it will cost
-- against once the forecast build-up runs (migration 038).
--
-- DELIBERATE RULING: account_id carries NO REFERENCES to LedgerCore's
-- accounts table. Rules 8 ("every *_id gets a REFERENCES constraint") and
-- 16 ("no app reads another app's tables directly") collide here, and 16
-- wins — the identical ruling migration 034 records for
-- fpa_assumptions.account_id and migration 032 for
-- ap_flow_line_items.account_id. Validity is enforced at the service layer
-- instead, via accountService.getAccountById (404 cross-tenant). Safe
-- because accounts are never actually deleted in this codebase — they are
-- retired via is_active = false — so a dangling account_id is not a
-- reachable state.
--
-- annual_salary_cents and fte_count carry >= 0 / >= 1 CHECKs deliberately,
-- unlike fpa_assumptions.fixed_cents which is allowed negative. A negative
-- salary is not a contra entry, it is a data error — and both values are
-- passed to scaleCents as a NUMERATOR, which rejects a negative one. The
-- CHECK is what makes that impossible at the storage layer rather than
-- only at the edge.

CREATE TABLE IF NOT EXISTS forecaster_headcount_roles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id             UUID NOT NULL,
  title               TEXT NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 120),
  department          TEXT NULL CHECK (department IS NULL OR length(department) <= 120),
  -- No REFERENCES accounts — rules 8 and 16 collide, 16 wins. See the header.
  account_id          UUID NOT NULL,
  starts_on           DATE NOT NULL CHECK (EXTRACT(DAY FROM starts_on) = 1),
  ends_on             DATE NULL CHECK (ends_on IS NULL OR EXTRACT(DAY FROM ends_on) = 1),
  fte_count           INT    NOT NULL DEFAULT 1 CHECK (fte_count BETWEEN 1 AND 1000),
  annual_salary_cents BIGINT NOT NULL CHECK (annual_salary_cents >= 0),
  loading_bps         INT    NOT NULL DEFAULT 0 CHECK (loading_bps BETWEEN 0 AND 10000),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_forecaster_headcount_plan
    FOREIGN KEY (org_id, plan_id) REFERENCES forecaster_plans (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_forecaster_headcount_end_after_start
    CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_forecaster_headcount_plan
  ON forecaster_headcount_roles (org_id, plan_id, starts_on);

CREATE OR REPLACE TRIGGER trg_forecaster_headcount_updated
  BEFORE UPDATE ON forecaster_headcount_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_forecaster_headcount_audit
  AFTER INSERT OR UPDATE OR DELETE ON forecaster_headcount_roles
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('forecaster');
