-- 050_ap-flow_auto_post.sql
-- Phase 19 — AP-Flow automated intake. See docs/roadmap.md#phase-19.
--
-- ap_flow_settings is this app's first per-org settings row (mirroring
-- ledger_settings's shape) — one row per organization, holding whether
-- auto-posting is on and the confidence/amount gates it applies. Off by
-- default: an organization has to opt in.
--
-- ap_flow_documents.auto_post_blockers records the exact reasons a clean
-- extraction did NOT auto-post, as data a reviewer can read rather than a
-- log line only an operator sees. It is reset to '[]' on every re-extraction
-- and on every successful post (the posted_complete CHECK from migration
-- 032 does not care about this column, so a POSTED row may still carry a
-- stale blockers array from its last EXTRACTED moment — harmless, since the
-- UI only ever shows blockers for a non-POSTED document).

CREATE TABLE IF NOT EXISTS ap_flow_settings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  auto_post_enabled         BOOLEAN NOT NULL DEFAULT false,
  auto_post_min_confidence  NUMERIC(4,3) NOT NULL DEFAULT 0.900
                            CHECK (auto_post_min_confidence >= 0.500 AND auto_post_min_confidence <= 1.000),
  auto_post_max_total_cents BIGINT NULL
                            CHECK (auto_post_max_total_cents IS NULL OR auto_post_max_total_cents > 0),
  updated_by                UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_ap_flow_settings_org UNIQUE (org_id)
);

CREATE INDEX IF NOT EXISTS idx_ap_flow_settings_updated_by ON ap_flow_settings (updated_by);

CREATE OR REPLACE TRIGGER trg_ap_flow_settings_updated
  BEFORE UPDATE ON ap_flow_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_ap_flow_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON ap_flow_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ap-flow');

ALTER TABLE ap_flow_documents
  ADD COLUMN IF NOT EXISTS auto_post_blockers JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ap_flow_documents_auto_post_blockers_array') THEN
    ALTER TABLE ap_flow_documents ADD CONSTRAINT chk_ap_flow_documents_auto_post_blockers_array
      CHECK (jsonb_typeof(auto_post_blockers) = 'array');
  END IF;
END $$;
