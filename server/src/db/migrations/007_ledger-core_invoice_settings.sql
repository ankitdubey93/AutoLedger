-- 007_ledger-core_invoice_settings.sql
-- Phase 3.8 — LedgerCore invoice settings: numbering, defaults, and branding.
-- See docs/schema.md and docs/ledger-core.md#phase-38--sales-invoicing.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

CREATE TABLE IF NOT EXISTS ledger_invoice_settings (
  org_id                     UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  number_prefix              TEXT NOT NULL DEFAULT 'INV-' CHECK (length(number_prefix) <= 12),
  number_padding              SMALLINT NOT NULL DEFAULT 6 CHECK (number_padding BETWEEN 1 AND 12),
  next_number                INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0),

  default_due_days           SMALLINT NOT NULL DEFAULT 30 CHECK (default_due_days BETWEEN 0 AND 365),
  default_tax_rate_bp        INTEGER NOT NULL DEFAULT 0 CHECK (default_tax_rate_bp BETWEEN 0 AND 10000),
  tax_label                  TEXT NOT NULL DEFAULT 'Tax' CHECK (length(btrim(tax_label)) > 0 AND length(tax_label) <= 24),

  -- Nullable: an org may not have designated posting accounts yet, and
  -- issueInvoice falls back to the default chart's 1120/4100(per line)/2140
  -- when these are unset (accountService.DEFAULT_CHART).
  receivable_account_id      UUID,
  default_revenue_account_id UUID,
  tax_payable_account_id     UUID,

  show_tax_number            BOOLEAN NOT NULL DEFAULT true,
  show_business_number       BOOLEAN NOT NULL DEFAULT false,
  show_legal_name            BOOLEAN NOT NULL DEFAULT true,

  billing_address            TEXT,
  payment_terms               TEXT,
  footer_notes                TEXT,
  accent_color                TEXT NOT NULL DEFAULT '#2563eb' CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FKs, same reasoning as ledger_settings.cash_account_id (005): a
  -- single-column FK would let one organization point at another tenant's
  -- account. ON DELETE RESTRICT because accounts are never actually deleted
  -- (retired via is_active = false), and a composite SET NULL would null
  -- org_id, this table's primary key.
  CONSTRAINT fk_invoice_settings_receivable_account
    FOREIGN KEY (org_id, receivable_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_settings_revenue_account
    FOREIGN KEY (org_id, default_revenue_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_settings_tax_account
    FOREIGN KEY (org_id, tax_payable_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
);

-- Rule 8: index every FK used in a join.
CREATE INDEX IF NOT EXISTS idx_invoice_settings_receivable_account ON ledger_invoice_settings (receivable_account_id);
CREATE INDEX IF NOT EXISTS idx_invoice_settings_revenue_account ON ledger_invoice_settings (default_revenue_account_id);
CREATE INDEX IF NOT EXISTS idx_invoice_settings_tax_account ON ledger_invoice_settings (tax_payable_account_id);

CREATE OR REPLACE TRIGGER trg_ledger_invoice_settings_updated_at
  BEFORE UPDATE ON ledger_invoice_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
