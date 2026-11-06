-- Phase 49g — paying suppliers from an Australian bank.
--
-- Account numbers are encrypted at rest (utils/secretBox.ts) and masked in every
-- response. A BSB identifies a branch and is not secret. Changing where money
-- goes is the classic supplier-fraud route, so vendor details are audited and
-- carry the time they last changed, which a pay run warns about.
CREATE TABLE IF NOT EXISTS bank_account_details (
  org_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id             UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
  bsb                    TEXT NOT NULL CHECK (bsb ~ '^[0-9]{3}-[0-9]{3}$'),
  account_number_enc     TEXT NOT NULL,
  account_number_last3   TEXT NOT NULL CHECK (length(account_number_last3) <= 3),
  account_name           TEXT NOT NULL CHECK (length(btrim(account_name)) > 0 AND length(account_name) <= 32),
  -- The ABA descriptive record's fields, which each bank issues.
  financial_institution  TEXT NOT NULL CHECK (financial_institution ~ '^[A-Z]{3}$'),
  apca_user_id           TEXT NOT NULL CHECK (apca_user_id ~ '^[0-9]{6}$'),
  -- Some banks require a balancing debit line in the file; others refuse one.
  self_balancing         BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_account_details_org ON bank_account_details (org_id);

CREATE TABLE IF NOT EXISTS vendor_bank_details (
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id             UUID PRIMARY KEY REFERENCES vendors(id) ON DELETE RESTRICT,
  bsb                   TEXT NOT NULL CHECK (bsb ~ '^[0-9]{3}-[0-9]{3}$'),
  account_number_enc    TEXT NOT NULL,
  account_number_last3  TEXT NOT NULL CHECK (length(account_number_last3) <= 3),
  account_name          TEXT NOT NULL CHECK (length(btrim(account_name)) > 0 AND length(account_name) <= 32),
  changed_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendor_bank_details_org ON vendor_bank_details (org_id);
CREATE INDEX IF NOT EXISTS idx_vendor_bank_details_changed_by ON vendor_bank_details (changed_by);

CREATE TABLE IF NOT EXISTS payment_batches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  payment_date     DATE NOT NULL,
  description      TEXT NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 12),
  total_cents      BIGINT NOT NULL CHECK (total_cents > 0),
  created_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_payment_batches_org_id_id UNIQUE (org_id, id)
);
CREATE INDEX IF NOT EXISTS idx_payment_batches_org ON payment_batches (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_batches_bank_account ON payment_batches (bank_account_id);
CREATE INDEX IF NOT EXISTS idx_payment_batches_created_by ON payment_batches (created_by);

CREATE TABLE IF NOT EXISTS payment_batch_items (
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id    UUID NOT NULL,
  payment_id  UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  vendor_id   UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, payment_id),
  CONSTRAINT fk_payment_batch_items_batch FOREIGN KEY (org_id, batch_id)
    REFERENCES payment_batches (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payment_batch_items_org ON payment_batch_items (org_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_batch_items_payment ON payment_batch_items (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_batch_items_vendor ON payment_batch_items (vendor_id);

CREATE OR REPLACE TRIGGER trg_bank_account_details_updated_at
  BEFORE UPDATE ON bank_account_details FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_bank_account_details_audit
  AFTER INSERT OR UPDATE OR DELETE ON bank_account_details FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
CREATE OR REPLACE TRIGGER trg_vendor_bank_details_audit
  AFTER INSERT OR UPDATE OR DELETE ON vendor_bank_details FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
CREATE OR REPLACE TRIGGER trg_payment_batches_audit
  AFTER INSERT OR UPDATE OR DELETE ON payment_batches FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
