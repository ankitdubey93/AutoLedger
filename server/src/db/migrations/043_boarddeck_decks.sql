-- 043_boarddeck_decks.sql
-- Phase 15 — BoardDeck Automator: automated .pptx deck generation. See
-- docs/roadmap.md#phase-15.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- A deck row is created synchronously; its bytes are not — generation runs
-- in the background-jobs worker (Phase 7) and the row's status advances
-- PENDING -> GENERATING -> READY|FAILED. The blob itself lives in
-- storageService (Phase 9.5's put/get), addressed here by sha256, exactly
-- as ap_flow_pages.redacted_sha256 addresses its own blobs — this is
-- deliberately NOT routed through the platform documents/Document Vault
-- table, since a .pptx is server-generated trusted output, not an
-- untrusted client upload, and utils/mimeSniff.ts's allowlist does not
-- include it.
--
-- No REFERENCES fiscal_periods/forecaster_plans on fiscal_period_id/plan_id
-- — rules 8 and 16 collide, 16 wins, the identical ruling migrations 032,
-- 034, 037-042 already carry. deckService validates both ids through the
-- owning app's service.
--
-- No immutability trigger — nothing in this phase ever reaches the general
-- ledger, the identical ruling fpa_models, forecaster_plans,
-- unitecon_product_lines and boarddeck_close_runs each carry.

CREATE TABLE IF NOT EXISTS boarddeck_decks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 160),
  -- No REFERENCES — see this file's header.
  fiscal_period_id  UUID NOT NULL,
  plan_id           UUID,
  period_starts_on  DATE NOT NULL,
  period_ends_on    DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'GENERATING', 'READY', 'FAILED')),
  sha256            TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  byte_size         BIGINT,
  slide_count       INTEGER,
  error_message     TEXT CHECK (error_message IS NULL OR length(error_message) <= 500),
  generated_at      TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_boarddeck_decks_period CHECK (period_ends_on >= period_starts_on),
  -- READY is the only status that may carry bytes, and it must.
  CONSTRAINT chk_boarddeck_decks_ready_artifact CHECK (
    (status =  'READY' AND sha256 IS NOT NULL AND byte_size IS NOT NULL
                       AND slide_count IS NOT NULL AND generated_at IS NOT NULL) OR
    (status <> 'READY' AND sha256 IS NULL     AND byte_size IS NULL
                       AND slide_count IS NULL AND generated_at IS NULL)
  ),
  -- FAILED is the only status that may carry an error, and it must.
  CONSTRAINT chk_boarddeck_decks_failed_error CHECK (
    (status =  'FAILED' AND error_message IS NOT NULL) OR
    (status <> 'FAILED' AND error_message IS NULL)
  ),
  CONSTRAINT ux_boarddeck_decks_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_boarddeck_decks_org_created
  ON boarddeck_decks (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_boarddeck_decks_org_status
  ON boarddeck_decks (org_id, status);
CREATE INDEX IF NOT EXISTS idx_boarddeck_decks_created_by ON boarddeck_decks (created_by);

CREATE OR REPLACE TRIGGER trg_boarddeck_decks_updated
  BEFORE UPDATE ON boarddeck_decks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_boarddeck_decks_audit
  AFTER INSERT OR UPDATE OR DELETE ON boarddeck_decks
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('boarddeck');
