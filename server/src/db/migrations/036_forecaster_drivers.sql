-- 036_forecaster_drivers.sql
-- Phase 13 — ForecasterPro: drivers and monthly driver values. See
-- docs/forecaster.md and docs/roadmap.md#phase-13.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- Two tables. forecaster_drivers is a named driver on a plan (unit count,
-- price, or rate). forecaster_driver_values hangs off a driver — one value
-- per month, replacing the plan's fixed rate assumption with a schedule a
-- user actually edits month by month.
--
-- ONE DELIBERATE RULING: `value` is a single BIGINT column whose unit is
-- decided by the parent driver's `kind` — COUNT is a plain integer count,
-- CENTS is money in integer cents, BPS is integer basis points. A per-kind
-- CHECK on `value` is impossible here because `kind` lives on the parent
-- row, not this one, so `driverService.setDriverValues` enforces
-- `value >= 0` for COUNT and BPS at write time (a CENTS driver may
-- legitimately be negative, e.g. a contra-revenue driver). That service
-- guard is load-bearing: it is what guarantees `scaleCents` — which rejects
-- a negative numerator — is never handed one by the engine in Phase 13's
-- forecast build (utils/forecasterBuild.ts). Same posture as
-- `assumptionService`'s circularity guard protecting `fpaProjection`'s
-- two-pass design (migration 034).

CREATE TABLE IF NOT EXISTS forecaster_drivers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id    UUID NOT NULL,
  name       TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  unit_label TEXT NOT NULL DEFAULT '' CHECK (length(unit_label) <= 40),
  kind       TEXT NOT NULL CHECK (kind IN ('COUNT','CENTS','BPS')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_forecaster_drivers_plan
    FOREIGN KEY (org_id, plan_id) REFERENCES forecaster_plans (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_forecaster_drivers_name      UNIQUE (org_id, plan_id, name),
  CONSTRAINT ux_forecaster_drivers_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_forecaster_drivers_plan
  ON forecaster_drivers (org_id, plan_id, name);

CREATE TABLE IF NOT EXISTS forecaster_driver_values (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id  UUID NOT NULL,
  month      DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  value      BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_forecaster_driver_values_driver
    FOREIGN KEY (org_id, driver_id) REFERENCES forecaster_drivers (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_forecaster_driver_values_month UNIQUE (org_id, driver_id, month)
);

CREATE INDEX IF NOT EXISTS idx_forecaster_driver_values_driver_month
  ON forecaster_driver_values (org_id, driver_id, month);

CREATE OR REPLACE TRIGGER trg_forecaster_drivers_updated
  BEFORE UPDATE ON forecaster_drivers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_forecaster_drivers_audit
  AFTER INSERT OR UPDATE OR DELETE ON forecaster_drivers
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('forecaster');

CREATE OR REPLACE TRIGGER trg_forecaster_driver_values_updated
  BEFORE UPDATE ON forecaster_driver_values FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_forecaster_driver_values_audit
  AFTER INSERT OR UPDATE OR DELETE ON forecaster_driver_values
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('forecaster');
