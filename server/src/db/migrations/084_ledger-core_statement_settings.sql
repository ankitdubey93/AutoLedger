-- 084_ledger-core_statement_settings.sql
-- Phase 39a — customer & vendor statement template settings: which layout a
-- statement prints in and the knobs the statement template editor exposes.
-- One row per organization; no row means "never configured" and
-- statementSettingsService returns STATEMENT_SETTINGS_DEFAULTS, which mirror
-- the column DEFAULTs below.
--
-- Like the invoice template (070), templates are a CLOSED SET of code-defined
-- layouts, never user-authored markup. The template_id IN list must change
-- together with INVOICE_TEMPLATE_IDS, and default_type with STATEMENT_TYPES,
-- both in server/src/config/constants.ts.
--
-- Idempotent: CREATE ... IF NOT EXISTS, and each named CHECK in its own
-- pg_constraint-guarded DO block. No money columns (rule 3).

CREATE TABLE IF NOT EXISTS ledger_statement_settings (
  org_id             UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  template_id        TEXT    NOT NULL DEFAULT 'classic',
  document_title     TEXT    NOT NULL DEFAULT 'STATEMENT',
  default_type       TEXT    NOT NULL DEFAULT 'OUTSTANDING',
  show_logo          BOOLEAN NOT NULL DEFAULT true,
  show_org_address   BOOLEAN NOT NULL DEFAULT true,
  show_aging_summary BOOLEAN NOT NULL DEFAULT true,
  show_remittance    BOOLEAN NOT NULL DEFAULT true,
  footer_notes       TEXT,
  accent_color       TEXT    NOT NULL DEFAULT '#2563eb',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_statement_settings_template_id') THEN
    ALTER TABLE ledger_statement_settings
      ADD CONSTRAINT ck_statement_settings_template_id
      CHECK (template_id IN ('classic', 'modern', 'compact'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_statement_settings_document_title') THEN
    ALTER TABLE ledger_statement_settings
      ADD CONSTRAINT ck_statement_settings_document_title
      CHECK (length(btrim(document_title)) > 0 AND length(document_title) <= 24);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_statement_settings_default_type') THEN
    ALTER TABLE ledger_statement_settings
      ADD CONSTRAINT ck_statement_settings_default_type
      CHECK (default_type IN ('OUTSTANDING', 'ACTIVITY'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_statement_settings_footer_notes') THEN
    ALTER TABLE ledger_statement_settings
      ADD CONSTRAINT ck_statement_settings_footer_notes
      CHECK (footer_notes IS NULL OR length(footer_notes) <= 500);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_statement_settings_accent_color') THEN
    ALTER TABLE ledger_statement_settings
      ADD CONSTRAINT ck_statement_settings_accent_color
      CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END $$;

CREATE OR REPLACE TRIGGER trg_ledger_statement_settings_updated_at
  BEFORE UPDATE ON ledger_statement_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_ledger_statement_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON ledger_statement_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
