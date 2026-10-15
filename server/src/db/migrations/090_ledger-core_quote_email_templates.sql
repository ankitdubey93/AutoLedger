-- 090_ledger-core_quote_email_templates.sql
-- Phase 42 slice C — user-editable subject/body for the quote email, per
-- direction (sales quote / purchase price confirmation), with [Placeholders]
-- from the closed registry in utils/placeholders.ts (surface QUOTE). At most
-- one default per (org, direction). Idempotent; the migration test replays it.

CREATE TABLE IF NOT EXISTS quote_email_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('SALES', 'PURCHASE')),
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 100),
  subject     TEXT NOT NULL CHECK (length(btrim(subject)) > 0 AND length(subject) <= 200),
  body        TEXT NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 5000),
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_quote_email_templates_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_quote_email_templates_org_direction
  ON quote_email_templates (org_id, direction);
CREATE INDEX IF NOT EXISTS idx_quote_email_templates_created_by
  ON quote_email_templates (created_by);
CREATE UNIQUE INDEX IF NOT EXISTS ux_quote_email_templates_default
  ON quote_email_templates (org_id, direction) WHERE is_default;

CREATE OR REPLACE TRIGGER trg_quote_email_templates_updated_at
  BEFORE UPDATE ON quote_email_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_quote_email_templates_audit
  AFTER INSERT OR UPDATE OR DELETE ON quote_email_templates
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
