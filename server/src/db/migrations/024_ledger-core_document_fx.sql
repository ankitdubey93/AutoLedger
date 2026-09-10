-- 024_ledger-core_document_fx.sql
-- Phase 8 — LedgerCore multi-currency FX engine, part 3: foreign-currency
-- invoices and bills. See docs/schema.md and
-- docs/ledger-core.md#d-multi-currency-fx-engine--phase-8.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fx_rate             NUMERIC(18,8) NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS base_subtotal_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS base_tax_cents      BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS base_total_cents    BIGINT NOT NULL DEFAULT 0;

ALTER TABLE bills ADD COLUMN IF NOT EXISTS fx_rate             NUMERIC(18,8) NOT NULL DEFAULT 1;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS base_subtotal_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS base_tax_cents      BIGINT NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS base_total_cents    BIGINT NOT NULL DEFAULT 0;

-- Backfill: every pre-Phase-8 document is base currency at rate 1, so its
-- base totals are its native totals. Idempotent — it only ever touches rows
-- still holding the column defaults, so a second run of this file (or a
-- replay against a database that already ran it) changes nothing further.
UPDATE invoices
   SET base_subtotal_cents = subtotal_cents,
       base_tax_cents      = tax_cents,
       base_total_cents    = total_cents
 WHERE fx_rate = 1 AND base_total_cents = 0 AND total_cents <> 0;

UPDATE bills
   SET base_subtotal_cents = subtotal_cents,
       base_tax_cents      = tax_cents,
       base_total_cents    = total_cents
 WHERE fx_rate = 1 AND base_total_cents = 0 AND total_cents <> 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_fx_rate') THEN
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_fx_rate
      CHECK (fx_rate > 0 AND fx_rate <= 1000000);
  END IF;

  -- No CHECK tying base_total_cents to round(total_cents * fx_rate): the base
  -- total is the sum of independently rounded subtotal and tax, which may
  -- legitimately differ from the rounded total by a cent. The GL-line CHECK
  -- (023's chk_ledger_lines_base_matches_rate) is where the per-line rate
  -- agreement is actually enforced; the GL entry is built from per-component
  -- amounts, not from this row's total.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoices_base_total') THEN
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_base_total
      CHECK (base_total_cents = base_subtotal_cents + base_tax_cents);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bills_fx_rate') THEN
    ALTER TABLE bills ADD CONSTRAINT chk_bills_fx_rate
      CHECK (fx_rate > 0 AND fx_rate <= 1000000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bills_base_total') THEN
    ALTER TABLE bills ADD CONSTRAINT chk_bills_base_total
      CHECK (base_total_cents = base_subtotal_cents + base_tax_cents);
  END IF;
END $$;
