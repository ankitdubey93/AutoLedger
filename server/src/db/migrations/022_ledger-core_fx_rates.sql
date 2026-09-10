-- 022_ledger-core_fx_rates.sql
-- Phase 8 — LedgerCore multi-currency FX engine, part 1: the rate table and
-- lookup. See docs/schema.md and docs/ledger-core.md#d-multi-currency-fx-engine--phase-8.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- A rate row is from_code -> to_code, and `rate` is how many units of to_code
-- one unit of from_code buys. Rates are always recorded foreign -> base (the
-- org's ledger_settings currency), so converting a native amount to base is
-- always a multiplication and never an inversion. `from_code`/`to_code`,
-- never `base_code`, to avoid colliding with organizations.base_currency,
-- which names a different "base" (the org's functional currency, not a
-- currency pair's base).

CREATE TABLE IF NOT EXISTS fx_rates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, not RESTRICT: a rate is reference data, not a posting. Deleting
  -- an organization that has rates but no journals must stay possible,
  -- matching vendors/customers rather than journal_entries.
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  from_code  CHAR(3) NOT NULL,
  to_code    CHAR(3) NOT NULL,
  rate_date  DATE NOT NULL,
  -- NUMERIC(18,8), matching ledger_lines.fx_rate (004) — a rate is a ratio
  -- needing sub-cent precision, the documented exception to "money is
  -- BIGINT" (rates are not amounts, guardrails rule 3).
  rate       NUMERIC(18,8) NOT NULL,
  source     TEXT NOT NULL DEFAULT 'MANUAL',

  -- An audit reference: the user who recorded this rate. RESTRICT so a user
  -- cannot be deleted out from under a rate they entered.
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_fx_rates_org_pair_date UNIQUE (org_id, from_code, to_code, rate_date),
  CONSTRAINT chk_fx_rates_from_code    CHECK (from_code ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_fx_rates_to_code      CHECK (to_code ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_fx_rates_different    CHECK (from_code <> to_code),
  -- 1,000,000 is not an arbitrary ceiling: RATE_SCALE (utils/fxRate.ts) is
  -- 1e8, so a rate's integer numerator is rate x 1e8 <= 1e14, comfortably
  -- inside Number.MAX_SAFE_INTEGER (~9.007e15) — the range check that lets
  -- scaleCents do FX conversion in exact BigInt with no bespoke parser.
  CONSTRAINT chk_fx_rates_rate_range   CHECK (rate > 0 AND rate <= 1000000),
  CONSTRAINT chk_fx_rates_source       CHECK (source IN ('MANUAL', 'IMPORT'))
);

-- Supports "the latest rate for this pair on or before a date" — the only
-- lookup this table serves. DESC on rate_date so a `LIMIT 1` after an
-- `<=` filter finds the most recent row without a separate sort step.
CREATE INDEX IF NOT EXISTS idx_fx_rates_lookup
  ON fx_rates (org_id, from_code, to_code, rate_date DESC);

CREATE OR REPLACE TRIGGER trg_fx_rates_updated_at
  BEFORE UPDATE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Phase 5's audit_row_change() — a rate is financial reference data, not
-- derived/regenerated, so unlike bank_match_suggestions it is audited.
CREATE OR REPLACE TRIGGER trg_fx_rates_audit
  AFTER INSERT OR UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
