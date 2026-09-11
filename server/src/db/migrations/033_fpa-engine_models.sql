-- 033_fpa-engine_models.sql
-- Phase 12 — FP&A Engine: models and scenarios. See docs/fpa-engine.md and
-- docs/roadmap.md#phase-12.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- Two tables. fpa_models is a named forecast container (a start month, a
-- horizon in months, the month through which actuals are considered final).
-- fpa_scenarios hangs off a model — one model, several scenarios (a BASE
-- case plus whatever UPSIDE/DOWNSIDE/CUSTOM variants the user builds), each
-- carrying its own DSO/DPO/tax-rate assumptions. A model always has exactly
-- one default scenario, enforced by a partial unique index below, not a
-- service check — the same technique migration 029 uses for
-- ux_migration_imports_one_committed_opening.
--
-- Four deliberate rulings, cited here so they are not re-argued elsewhere:
--
-- (a) NEITHER TABLE HAS AN IMMUTABILITY TRIGGER, AND status HAS NO
-- TERMINAL STATE. Every other FSM in this codebase enforces immutability
-- once a document reaches the general ledger — ap_flow_documents.POSTED
-- (migration 032), fiscal_periods.LOCKED (015), migration_imports.COMMITTED
-- (029). FP&A posts nothing to the GL, ever: a model is read-only arithmetic
-- over LedgerCore's actuals, never a source document. Rule 6 ("posted
-- financial documents are immutable") therefore does not apply, and
-- PATCH/DELETE on a model or scenario are correct, not a violation.
-- fpa_models.status cycles DRAFT <-> ACTIVE <-> ARCHIVED with no dead end —
-- see types/fpa-engine.ts's FPA_MODEL_TRANSITIONS, which this CHECK must
-- keep matching exactly.
--
-- (b) starts_on and actuals_through are constrained to the first of a month.
-- FP&A projects in monthly calendar buckets, not LedgerCore's fiscal
-- periods (015) — a projection horizon is not a closeable accounting period.
--
-- (c) Percentages are integer basis points (INT), never NUMERIC. Every
-- application of dso_days/dpo_days/tax_rate_bps downstream is
-- scaleCents(amount, n, 10000 | 30) — exact BigInt scaling, zero
-- floating-point (guardrails rule 3). Contrast with fx_rates.rate (022),
-- which genuinely needs 8 decimal places and pays for that by staying a
-- string end to end; a growth or tax rate does not need that precision and
-- integers are both cheaper and exact.
--
-- (d) Both tables are audited. A scenario's DSO/tax assumptions are business
-- state a user deliberately sets and revisits — not derived output
-- regenerated wholesale on every read, the ruling bank_match_suggestions
-- and ap_flow_pages carry in the opposite direction.

CREATE TABLE IF NOT EXISTS fpa_models (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  description     TEXT NULL CHECK (description IS NULL OR length(description) <= 1000),
  -- Monthly calendar buckets, not fiscal periods — see ruling (b) above.
  starts_on       DATE NOT NULL CHECK (EXTRACT(DAY FROM starts_on) = 1),
  horizon_months  INT  NOT NULL CHECK (horizon_months BETWEEN 1 AND 60),
  actuals_through DATE NOT NULL CHECK (EXTRACT(DAY FROM actuals_through) = 1),
  -- No terminal state — see ruling (a) above. Must match
  -- types/fpa-engine.ts's FPA_MODEL_STATUSES exactly.
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  created_by      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_fpa_models_name      UNIQUE (org_id, name),
  CONSTRAINT ux_fpa_models_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_fpa_models_actuals_before_start CHECK (actuals_through < starts_on)
);

CREATE INDEX IF NOT EXISTS idx_fpa_models_org_status
  ON fpa_models (org_id, status, starts_on DESC);
CREATE INDEX IF NOT EXISTS idx_fpa_models_created_by ON fpa_models (created_by);

CREATE TABLE IF NOT EXISTS fpa_scenarios (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_id     UUID NOT NULL,
  name         TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  kind         TEXT NOT NULL CHECK (kind IN ('BASE','UPSIDE','DOWNSIDE','CUSTOM')),
  is_default   BOOLEAN NOT NULL DEFAULT false,
  -- Integer basis points, never NUMERIC — see ruling (c) above.
  dso_days     INT NOT NULL DEFAULT 0 CHECK (dso_days BETWEEN 0 AND 365),
  dpo_days     INT NOT NULL DEFAULT 0 CHECK (dpo_days BETWEEN 0 AND 365),
  tax_rate_bps INT NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_fpa_scenarios_model
    FOREIGN KEY (org_id, model_id) REFERENCES fpa_models (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_fpa_scenarios_name      UNIQUE (org_id, model_id, name),
  CONSTRAINT ux_fpa_scenarios_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_fpa_scenarios_model
  ON fpa_scenarios (org_id, model_id, name);

-- Exactly one default scenario per model — a partial unique index, not a
-- service check. See migration 029's ux_migration_imports_one_committed_opening
-- for the identical technique.
CREATE UNIQUE INDEX IF NOT EXISTS ux_fpa_scenarios_one_default
  ON fpa_scenarios (org_id, model_id) WHERE is_default;

CREATE OR REPLACE TRIGGER trg_fpa_models_updated
  BEFORE UPDATE ON fpa_models FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_fpa_scenarios_updated
  BEFORE UPDATE ON fpa_scenarios FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Both tables are audited — see ruling (d) above.
CREATE OR REPLACE TRIGGER trg_fpa_models_audit
  AFTER INSERT OR UPDATE OR DELETE ON fpa_models
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('fpa-engine');
CREATE OR REPLACE TRIGGER trg_fpa_scenarios_audit
  AFTER INSERT OR UPDATE OR DELETE ON fpa_scenarios
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('fpa-engine');
