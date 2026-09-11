-- 034_fpa-engine_assumptions.sql
-- Phase 12 — FP&A Engine: assumptions. See docs/fpa-engine.md and
-- docs/roadmap.md#phase-12.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- One table: fpa_assumptions, hanging off fpa_scenarios (migration 033).
-- Each row is one account's growth/fixed/percent-of-revenue rule within one
-- scenario. There is no assumption for an account means "flat-line the last
-- actual" — the engine's own default (utils/fpaProjection.ts), not encoded
-- here.
--
-- Deliberate ruling, cited wherever it matters: account_id carries NO
-- REFERENCES to LedgerCore's accounts table. Guardrails rule 8 ("every *_id
-- gets a REFERENCES constraint") and rule 16 ("no app reads another app's
-- tables directly... app boundaries are namespaces, not tenancy") collide
-- here, and rule 16 wins — the identical ruling migration 032 records for
-- ap_flow_line_items.account_id. Validity is enforced at the service layer
-- via accountService.getAccountById (404 cross-tenant), not a schema-level
-- FK. Safe because accounts are never actually deleted in this codebase —
-- they are retired via is_active = false — so a dangling account_id is not
-- a reachable state.
--
-- Percentages/rates are integer basis points (INT), never NUMERIC — every
-- application downstream is scaleCents(amount, n, 10000), exact BigInt
-- scaling (guardrails rule 3), the same convention migration 033 sets for
-- dso_days/dpo_days/tax_rate_bps.
--
-- fixed_cents gets no >= 0 CHECK: a contra-revenue or credit-side assumption
-- can legitimately read negative off a model, mirroring
-- ap_flow_line_items.amount_cents (migration 032).
--
-- The kind/payload CHECK below is a discriminated union expressed in SQL:
-- the column the kind names is NOT NULL and the other two are NULL. Without
-- it, a GROWTH_BPS row could carry a stale fixed_cents and the engine's
-- behaviour would depend on which column it happened to read. The service's
-- zod schema (schemas/fpa-engine/assumptionSchema.ts) rejects a
-- kind/payload mismatch at the edge with a 400 first — this CHECK is the
-- backstop, not the first line of defence.

CREATE TABLE IF NOT EXISTS fpa_assumptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scenario_id UUID NOT NULL,
  -- No REFERENCES accounts — see the header comment.
  account_id  UUID NOT NULL,
  kind        TEXT NOT NULL
              CHECK (kind IN ('GROWTH_BPS','FIXED_CENTS','PERCENT_OF_REVENUE_BPS')),
  growth_bps             INT NULL
                         CHECK (growth_bps IS NULL OR growth_bps BETWEEN -10000 AND 100000),
  fixed_cents            BIGINT NULL,
  percent_of_revenue_bps INT NULL
                         CHECK (percent_of_revenue_bps IS NULL
                                OR percent_of_revenue_bps BETWEEN 0 AND 10000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_fpa_assumptions_scenario
    FOREIGN KEY (org_id, scenario_id) REFERENCES fpa_scenarios (org_id, id) ON DELETE CASCADE,
  CONSTRAINT ux_fpa_assumptions_account UNIQUE (org_id, scenario_id, account_id),

  CONSTRAINT chk_fpa_assumptions_kind_payload CHECK (
       (kind = 'GROWTH_BPS'             AND growth_bps IS NOT NULL             AND fixed_cents IS NULL AND percent_of_revenue_bps IS NULL)
    OR (kind = 'FIXED_CENTS'            AND fixed_cents IS NOT NULL            AND growth_bps IS NULL  AND percent_of_revenue_bps IS NULL)
    OR (kind = 'PERCENT_OF_REVENUE_BPS' AND percent_of_revenue_bps IS NOT NULL AND growth_bps IS NULL  AND fixed_cents IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_fpa_assumptions_scenario
  ON fpa_assumptions (org_id, scenario_id, account_id);

CREATE OR REPLACE TRIGGER trg_fpa_assumptions_updated
  BEFORE UPDATE ON fpa_assumptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_fpa_assumptions_audit
  AFTER INSERT OR UPDATE OR DELETE ON fpa_assumptions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('fpa-engine');
