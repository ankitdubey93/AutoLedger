-- 070_ledger-core_invoice_template.sql
-- Phase 30 — invoice template settings: which layout an invoice prints in and
-- the knobs the template editor exposes (title, font, density, section
-- toggles, bank details). Extends ledger_invoice_settings (migration 007).
--
-- Templates are a CLOSED SET of code-defined layouts, not user-authored
-- markup. The template_id CHECK below is what makes rendering by id safe: no
-- request value ever reaches the DOM as markup. The IN list in
-- ck_invoice_settings_template_id and INVOICE_TEMPLATE_IDS in
-- server/src/config/constants.ts must be changed together (likewise the font
-- and density lists against INVOICE_FONT_FAMILIES / INVOICE_DENSITIES).
--
-- Every statement is idempotent. Postgres has no ADD CONSTRAINT IF NOT EXISTS,
-- so each CHECK sits in its own pg_constraint-guarded DO block; the migration
-- test replays every file. No money columns are added here (rule 3).

ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS template_id        TEXT    NOT NULL DEFAULT 'classic';
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS document_title     TEXT    NOT NULL DEFAULT 'INVOICE';
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS font_family        TEXT    NOT NULL DEFAULT 'sans';
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS density            TEXT    NOT NULL DEFAULT 'comfortable';
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS show_logo          BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS show_org_address   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS show_payment_terms BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS show_due_date      BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS bank_details       TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoice_settings_template_id') THEN
    ALTER TABLE ledger_invoice_settings
      ADD CONSTRAINT ck_invoice_settings_template_id
      CHECK (template_id IN ('classic', 'modern', 'compact'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoice_settings_font_family') THEN
    ALTER TABLE ledger_invoice_settings
      ADD CONSTRAINT ck_invoice_settings_font_family
      CHECK (font_family IN ('sans', 'serif'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoice_settings_density') THEN
    ALTER TABLE ledger_invoice_settings
      ADD CONSTRAINT ck_invoice_settings_density
      CHECK (density IN ('comfortable', 'compact'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoice_settings_document_title') THEN
    ALTER TABLE ledger_invoice_settings
      ADD CONSTRAINT ck_invoice_settings_document_title
      CHECK (length(btrim(document_title)) > 0 AND length(document_title) <= 24);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoice_settings_bank_details') THEN
    ALTER TABLE ledger_invoice_settings
      ADD CONSTRAINT ck_invoice_settings_bank_details
      CHECK (bank_details IS NULL OR length(bank_details) <= 500);
  END IF;
END $$;
