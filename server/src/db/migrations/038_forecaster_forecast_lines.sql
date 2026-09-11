-- 038_forecaster_forecast_lines.sql
-- Phase 13 — ForecasterPro: forecast lines. See docs/forecaster.md and
-- docs/roadmap.md#phase-13.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- One table: forecaster_forecast_lines, hanging off a plan. Each line ties
-- an account to one of three formula kinds — DRIVER_PRODUCT (quantity x
-- rate, two drivers), DRIVER_PERCENT (a percentage of a driver), or
-- FIXED_CENTS (the same amount every month). `GET /plans/:id/forecast`
-- (utils/forecasterBuild.ts) evaluates every line for every month of the
-- plan's horizon.
--
-- No REFERENCES accounts — rules 8 and 16 collide, 16 wins (migrations 032,
-- 034, 037 already carry the identical ruling).
--
-- TWO DELIBERATE RULINGS:
--
-- (a) The three driver FKs are NULLABLE COMPOSITE FKs. PostgreSQL's default
-- MATCH SIMPLE skips the check entirely when ANY column of the key is
-- NULL — since org_id is never NULL and the driver id is NULL on two of
-- the three kinds, the constraint is enforced exactly on the kind that
-- uses it and silently skipped on the kinds that do not. That is the
-- intended behaviour, not an accident.
--
-- (b) ON DELETE RESTRICT, not CASCADE, on every driver FK: deleting a
-- driver a forecast line depends on must fail loudly (23503, surfaced by
-- driverService.deleteDriver as a 409), never silently zero out a
-- forecast.

CREATE TABLE IF NOT EXISTS forecaster_forecast_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id            UUID NOT NULL,
  -- No REFERENCES accounts — rules 8 and 16 collide, 16 wins (migrations 032, 034, 037).
  account_id         UUID NOT NULL,
  label              TEXT NOT NULL CHECK (length(btrim(label)) > 0 AND length(label) <= 120),
  kind               TEXT NOT NULL
                     CHECK (kind IN ('DRIVER_PRODUCT','DRIVER_PERCENT','FIXED_CENTS')),
  quantity_driver_id UUID   NULL,
  rate_driver_id     UUID   NULL,
  source_driver_id   UUID   NULL,
  percent_bps        INT    NULL CHECK (percent_bps IS NULL OR percent_bps BETWEEN 0 AND 100000),
  fixed_cents        BIGINT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_forecaster_lines_plan
    FOREIGN KEY (org_id, plan_id) REFERENCES forecaster_plans (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_forecaster_lines_quantity_driver
    FOREIGN KEY (org_id, quantity_driver_id) REFERENCES forecaster_drivers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_forecaster_lines_rate_driver
    FOREIGN KEY (org_id, rate_driver_id) REFERENCES forecaster_drivers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_forecaster_lines_source_driver
    FOREIGN KEY (org_id, source_driver_id) REFERENCES forecaster_drivers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ux_forecaster_lines_label UNIQUE (org_id, plan_id, label),

  CONSTRAINT chk_forecaster_lines_kind_payload CHECK (
       (kind = 'DRIVER_PRODUCT' AND quantity_driver_id IS NOT NULL AND rate_driver_id IS NOT NULL
          AND source_driver_id IS NULL AND percent_bps IS NULL AND fixed_cents IS NULL)
    OR (kind = 'DRIVER_PERCENT' AND source_driver_id IS NOT NULL AND percent_bps IS NOT NULL
          AND quantity_driver_id IS NULL AND rate_driver_id IS NULL AND fixed_cents IS NULL)
    OR (kind = 'FIXED_CENTS'    AND fixed_cents IS NOT NULL
          AND quantity_driver_id IS NULL AND rate_driver_id IS NULL AND source_driver_id IS NULL
          AND percent_bps IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_forecaster_lines_plan
  ON forecaster_forecast_lines (org_id, plan_id, label);
CREATE INDEX IF NOT EXISTS idx_forecaster_lines_quantity_driver
  ON forecaster_forecast_lines (org_id, quantity_driver_id);
CREATE INDEX IF NOT EXISTS idx_forecaster_lines_rate_driver
  ON forecaster_forecast_lines (org_id, rate_driver_id);
CREATE INDEX IF NOT EXISTS idx_forecaster_lines_source_driver
  ON forecaster_forecast_lines (org_id, source_driver_id);

CREATE OR REPLACE TRIGGER trg_forecaster_lines_updated
  BEFORE UPDATE ON forecaster_forecast_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_forecaster_lines_audit
  AFTER INSERT OR UPDATE OR DELETE ON forecaster_forecast_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('forecaster');
