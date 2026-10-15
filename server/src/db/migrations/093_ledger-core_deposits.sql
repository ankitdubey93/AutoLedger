-- 093_ledger-core_deposits.sql
-- Phase 42 (Slice G) — deposits and prepayments against orders.
--
--   A deposit INVOICE (invoices.kind = 'DEPOSIT') posts DR AR / CR 2130 Customer
--   Deposits (an IFRS 15 contract liability). A deposit BILL posts DR 1150
--   Supplier Prepayments / CR AP. A deposit APPLICATION later moves the deposit
--   onto the order's final invoice/bill (DR 2130 / CR AR, or DR AP / CR 1150)
--   and is a third settlement source beside payments and note allocations.
--
-- Base currency only this phase: base_amount_cents must equal amount_cents.
-- Idempotent throughout; the migration test replays every file.

-- ------------------------------------------------ default chart: 2130 and 1150
-- Modelled on 071: the EXISTS guard stops an organization with no chart
-- receiving orphan rows; ON CONFLICT skips an org whose imported chart already
-- uses the code. accountService.DEFAULT_CHART gains the same rows (Step G2).

INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT o.id, '2130', 'Customer Deposits', 'Liability', true,
       (SELECT p.id FROM accounts p WHERE p.org_id = o.id AND p.code = '2010')
  FROM organizations o
 WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '2010')
ON CONFLICT (org_id, code) DO NOTHING;

INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT o.id, '1150', 'Supplier Prepayments', 'Asset', true,
       (SELECT p.id FROM accounts p WHERE p.org_id = o.id AND p.code = '1100')
  FROM organizations o
 WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '1100')
ON CONFLICT (org_id, code) DO NOTHING;

-- ------------------------------------------------------ settings: the accounts

ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS customer_deposit_account_id    UUID NULL;
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS supplier_prepayment_account_id UUID NULL;

-- SET NULL on the column only (PostgreSQL 15+): the composite key includes the
-- NOT NULL org_id, which a plain SET NULL would try to null.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_invoice_settings_customer_deposit_account') THEN
    ALTER TABLE ledger_invoice_settings ADD CONSTRAINT fk_ledger_invoice_settings_customer_deposit_account
      FOREIGN KEY (org_id, customer_deposit_account_id) REFERENCES accounts (org_id, id)
      ON DELETE SET NULL (customer_deposit_account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_invoice_settings_supplier_prepayment_account') THEN
    ALTER TABLE ledger_invoice_settings ADD CONSTRAINT fk_ledger_invoice_settings_supplier_prepayment_account
      FOREIGN KEY (org_id, supplier_prepayment_account_id) REFERENCES accounts (org_id, id)
      ON DELETE SET NULL (supplier_prepayment_account_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ledger_invoice_settings_customer_deposit_account
  ON ledger_invoice_settings (customer_deposit_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoice_settings_supplier_prepayment_account
  ON ledger_invoice_settings (supplier_prepayment_account_id);

-- ----------------------------------------------- invoices / bills: deposit kind
-- kind and deposit_for_order_id are set only at INSERT of a DRAFT, so the
-- 009/013 immutability triggers (which freeze every column once issued) are
-- unaffected.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deposit_for_order_id UUID NULL;
ALTER TABLE bills    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE bills    ADD COLUMN IF NOT EXISTS deposit_for_order_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoices_kind') THEN
    ALTER TABLE invoices ADD CONSTRAINT ck_invoices_kind CHECK (kind IN ('STANDARD', 'DEPOSIT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoices_deposit_order') THEN
    ALTER TABLE invoices ADD CONSTRAINT ck_invoices_deposit_order
      CHECK ((kind = 'DEPOSIT') = (deposit_for_order_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_deposit_order') THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_deposit_order
      FOREIGN KEY (org_id, deposit_for_order_id) REFERENCES orders (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_bills_kind') THEN
    ALTER TABLE bills ADD CONSTRAINT ck_bills_kind CHECK (kind IN ('STANDARD', 'DEPOSIT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_bills_deposit_order') THEN
    ALTER TABLE bills ADD CONSTRAINT ck_bills_deposit_order
      CHECK ((kind = 'DEPOSIT') = (deposit_for_order_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bills_deposit_order') THEN
    ALTER TABLE bills ADD CONSTRAINT fk_bills_deposit_order
      FOREIGN KEY (org_id, deposit_for_order_id) REFERENCES orders (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_deposit_order ON invoices (org_id, deposit_for_order_id) WHERE deposit_for_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_deposit_order    ON bills (org_id, deposit_for_order_id)    WHERE deposit_for_order_id IS NOT NULL;

-- ------------------------------------------------------ quotes: deposit percent
-- Frozen at send by 089's whole-row-diff trigger (every column not on its
-- allow-list is immutable once the quote leaves DRAFT), so no trigger change.

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS deposit_percent_bp INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_quotes_deposit_percent_bp') THEN
    ALTER TABLE quotes ADD CONSTRAINT ck_quotes_deposit_percent_bp
      CHECK (deposit_percent_bp IS NULL OR deposit_percent_bp BETWEEN 1 AND 10000);
  END IF;
END $$;

-- ------------------------------------------------------- deposit_applications
-- Insert-only apart from the POSTED -> VOID transition. Like the note
-- allocations (063), an application stops counting toward settlement once VOID.

CREATE TABLE IF NOT EXISTS deposit_applications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  direction             TEXT NOT NULL CHECK (direction IN ('SALES', 'PURCHASE')),
  deposit_invoice_id    UUID NULL,
  target_invoice_id     UUID NULL,
  deposit_bill_id       UUID NULL,
  target_bill_id        UUID NULL,
  amount_cents          BIGINT NOT NULL CHECK (amount_cents > 0),
  base_amount_cents     BIGINT NOT NULL CHECK (base_amount_cents = amount_cents),
  application_date      DATE NOT NULL,
  journal_entry_id      UUID NOT NULL,
  status                TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  void_journal_entry_id UUID NULL,
  voided_at             TIMESTAMPTZ NULL,
  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_deposit_applications_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ck_deposit_applications_shape CHECK (
    (direction = 'SALES' AND deposit_invoice_id IS NOT NULL AND target_invoice_id IS NOT NULL
                         AND deposit_bill_id IS NULL AND target_bill_id IS NULL)
    OR
    (direction = 'PURCHASE' AND deposit_bill_id IS NOT NULL AND target_bill_id IS NOT NULL
                            AND deposit_invoice_id IS NULL AND target_invoice_id IS NULL)
  ),
  CONSTRAINT ck_deposit_applications_void CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL AND void_journal_entry_id IS NOT NULL)
  ),
  CONSTRAINT fk_deposit_applications_deposit_invoice
    FOREIGN KEY (org_id, deposit_invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_applications_target_invoice
    FOREIGN KEY (org_id, target_invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_applications_deposit_bill
    FOREIGN KEY (org_id, deposit_bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_applications_target_bill
    FOREIGN KEY (org_id, target_bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_applications_journal_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_applications_void_journal_entry
    FOREIGN KEY (org_id, void_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_deposit_applications_org_direction ON deposit_applications (org_id, direction, application_date DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_applications_deposit_invoice ON deposit_applications (deposit_invoice_id) WHERE deposit_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposit_applications_target_invoice  ON deposit_applications (target_invoice_id)  WHERE target_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposit_applications_deposit_bill    ON deposit_applications (deposit_bill_id)    WHERE deposit_bill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposit_applications_target_bill     ON deposit_applications (target_bill_id)     WHERE target_bill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposit_applications_journal_entry   ON deposit_applications (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_deposit_applications_void_journal    ON deposit_applications (void_journal_entry_id) WHERE void_journal_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposit_applications_created_by      ON deposit_applications (created_by);

-- DELETE is always refused; UPDATE is only POSTED -> VOID, touching only
-- status, voided_at and void_journal_entry_id (the 009 to_jsonb diff).
CREATE OR REPLACE FUNCTION reject_deposit_application_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deposit application % cannot be deleted', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  IF NOT (OLD.status = 'POSTED' AND NEW.status = 'VOID') THEN
    RAISE EXCEPTION 'Deposit application % is % and is immutable', OLD.id, OLD.status
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - 'status' - 'voided_at' - 'void_journal_entry_id'
     IS DISTINCT FROM
     to_jsonb(OLD) - 'status' - 'voided_at' - 'void_journal_entry_id' THEN
    RAISE EXCEPTION 'Voiding deposit application % may not change any other field', OLD.id
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_deposit_applications_immutable
  BEFORE UPDATE OR DELETE ON deposit_applications
  FOR EACH ROW EXECUTE FUNCTION reject_deposit_application_mutation();

CREATE OR REPLACE TRIGGER trg_deposit_applications_audit
  AFTER INSERT OR UPDATE OR DELETE ON deposit_applications
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
