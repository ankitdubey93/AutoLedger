-- 025_ledger-core_payment_fx.sql
-- Phase 8 — LedgerCore multi-currency FX engine, part 4: payment currency,
-- realized FX posting accounts, and the allocation currency guard. See
-- docs/schema.md and docs/ledger-core.md#d-multi-currency-fx-engine--phase-8.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS fx_rate           NUMERIC(18,8) NOT NULL DEFAULT 1;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS base_amount_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS base_amount_cents BIGINT NOT NULL DEFAULT 0;

-- Backfill: every pre-Phase-8 payment/allocation is base currency at rate 1,
-- so its base amount is its native amount. Idempotent — only rows still at
-- the column defaults are touched.
UPDATE payments SET base_amount_cents = amount_cents
 WHERE fx_rate = 1 AND base_amount_cents = 0 AND amount_cents <> 0;

UPDATE payment_allocations SET base_amount_cents = amount_cents
 WHERE base_amount_cents = 0 AND amount_cents <> 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payments_fx_rate') THEN
    ALTER TABLE payments ADD CONSTRAINT chk_payments_fx_rate
      CHECK (fx_rate > 0 AND fx_rate <= 1000000);
  END IF;
END $$;

-- Three nullable FX posting-account columns on ledger_settings, mirroring
-- 012's AP posting accounts exactly: composite FK to accounts (org_id, id),
-- ON DELETE RESTRICT (accounts are retired via is_active, never deleted),
-- no backfill needed since NULL falls back to a chart code in the service
-- (4910/6810/6820 — seeded for every organization since Phase 3, precisely
-- so this phase would not need a chart backfill of its own).
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS realized_fx_gain_account_id  UUID;
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS realized_fx_loss_account_id  UUID;
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS unrealized_fx_account_id     UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_realized_fx_gain_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_realized_fx_gain_account
      FOREIGN KEY (org_id, realized_fx_gain_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_realized_fx_loss_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_realized_fx_loss_account
      FOREIGN KEY (org_id, realized_fx_loss_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_unrealized_fx_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_unrealized_fx_account
      FOREIGN KEY (org_id, unrealized_fx_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Rule 8: index every FK used in a join.
CREATE INDEX IF NOT EXISTS idx_ledger_settings_realized_fx_gain_account ON ledger_settings (realized_fx_gain_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_settings_realized_fx_loss_account ON ledger_settings (realized_fx_loss_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_settings_unrealized_fx_account    ON ledger_settings (unrealized_fx_account_id);

-- A payment may only allocate to a document in its own currency — enforced
-- here, independently of the service, mirroring the "database is the
-- guardrail" posture of assert_account_is_postable (004). A plain BEFORE
-- INSERT trigger, not deferred: it depends only on rows that already exist
-- (the payment and the document), so there is no reason to wait for COMMIT.
-- Both lookups carry org_id — this trigger is a tenancy boundary too.
CREATE OR REPLACE FUNCTION assert_allocation_currency_matches() RETURNS trigger AS $$
DECLARE
  payment_currency  CHAR(3);
  document_currency CHAR(3);
BEGIN
  SELECT currency_code INTO payment_currency
    FROM payments WHERE id = NEW.payment_id AND org_id = NEW.org_id;

  IF NEW.invoice_id IS NOT NULL THEN
    SELECT currency_code INTO document_currency
      FROM invoices WHERE id = NEW.invoice_id AND org_id = NEW.org_id;
  ELSIF NEW.bill_id IS NOT NULL THEN
    SELECT currency_code INTO document_currency
      FROM bills WHERE id = NEW.bill_id AND org_id = NEW.org_id;
  ELSE
    -- Neither target set: chk_allocation_one_target's job to reject, not
    -- this trigger's — a BEFORE trigger fires ahead of CHECK validation, so
    -- raising here would preempt that constraint's own, more specific error.
    RETURN NEW;
  END IF;

  -- The target id didn't resolve to a row in this org (wrong id, or another
  -- tenant's document) — that is fk_allocation_invoice/fk_allocation_bill's
  -- job to reject. Only compare currencies once both sides are actually known.
  IF document_currency IS NULL THEN
    RETURN NEW;
  END IF;

  IF payment_currency IS DISTINCT FROM document_currency THEN
    RAISE EXCEPTION
      'payment currency % cannot settle a document in %', payment_currency, document_currency
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_allocations_currency
  BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION assert_allocation_currency_matches();
