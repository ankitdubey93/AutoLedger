-- 051_platform_ai_model_calls.sql
-- Phase 19.1 — AI token and cost metering. See docs/roadmap.md#phase-191-as-delivered.
--
-- Five rulings this table's shape depends on:
--
-- 1. PLATFORM TABLE, NOT AN APP TABLE. It spans every app that calls a
--    model, and `app_slug` carries the namespace — exactly as `audit_logs`,
--    `document_links`, `outbox_events` and `onboarding_states` already do
--    (guardrails rule 16). AP-Flow is the first writer; TaxGuard AI can
--    adopt it later with zero migration.
--
-- 2. `entity_id` CARRIES NO `REFERENCES`. The identical rule-16-over-rule-8
--    ruling `document_links.entity_id`, `journal_entries.source_id` and
--    `ap_flow_line_items.account_id` already carry — a platform table must
--    not hard-wire an FK into an app's own schema. Validity is a
--    service-layer concern, not a schema one.
--
-- 3. `BEFORE UPDATE` ONLY, NEVER `BEFORE DELETE`. A spend record is never
--    amended, but `ON DELETE CASCADE` from `organizations` must still be
--    able to remove an org's rows wholesale. A `BEFORE DELETE` trigger
--    would block that cascade.
--
-- 4. DELIBERATELY NOT AUDITED. `audit_row_change` exists to capture UPDATEs
--    and DELETEs; this table admits neither by construction (see 3), so CDC
--    would only duplicate every INSERT into a second append-only table at
--    the same volume. The same volume-and-derivation reasoning `ap_flow_pages`
--    (031) and `bank_match_suggestions` (019) already carry.
--
-- 5. `cost_micro_usd` IS NULLABLE ON PURPOSE. A model with no verified price
--    (config/aiPricing.ts) records its tokens honestly rather than a
--    fabricated cost, and `chk_ai_model_calls_cost_pair` makes "a cost with
--    no pricing version" unrepresentable.

CREATE TABLE IF NOT EXISTS ai_model_calls (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_slug            TEXT NOT NULL CHECK (length(btrim(app_slug)) BETWEEN 1 AND 50),
  purpose             TEXT NOT NULL CHECK (purpose IN ('EXTRACT','CLASSIFY','ANSWER','EMBED')),
  provider            TEXT NOT NULL CHECK (provider IN ('anthropic','gemini','voyage')),
  model               TEXT NOT NULL CHECK (length(btrim(model)) > 0 AND length(model) <= 100),
  entity_type         TEXT NULL CHECK (entity_type IS NULL OR length(entity_type) <= 50),
  entity_id           UUID NULL,
  input_tokens        BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  reasoning_tokens    BIGINT NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  total_tokens        BIGINT NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  cost_micro_usd      BIGINT NULL CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  pricing_version     TEXT NULL CHECK (pricing_version IS NULL OR length(pricing_version) <= 40),
  status              TEXT NOT NULL CHECK (status IN ('OK','ERROR')),
  error_code          TEXT NULL CHECK (error_code IS NULL OR length(error_code) <= 100),
  latency_ms          INT NOT NULL CHECK (latency_ms >= 0),
  created_by          UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_ai_model_calls_cost_pair
    CHECK ((cost_micro_usd IS NULL) = (pricing_version IS NULL)),
  CONSTRAINT chk_ai_model_calls_error
    CHECK ((status = 'OK' AND error_code IS NULL) OR (status = 'ERROR' AND error_code IS NOT NULL)),
  CONSTRAINT chk_ai_model_calls_entity_pair
    CHECK ((entity_type IS NULL) = (entity_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_ai_model_calls_org_created
  ON ai_model_calls (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_model_calls_org_app_created
  ON ai_model_calls (org_id, app_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_model_calls_entity
  ON ai_model_calls (org_id, entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_model_calls_created_by
  ON ai_model_calls (created_by);

CREATE OR REPLACE FUNCTION reject_ai_model_call_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ai_model_calls is append-only'
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ai_model_calls_no_update
  BEFORE UPDATE ON ai_model_calls
  FOR EACH ROW EXECUTE FUNCTION reject_ai_model_call_mutation();
