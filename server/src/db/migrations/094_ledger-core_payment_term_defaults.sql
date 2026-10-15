-- 094_ledger-core_payment_term_defaults.sql
-- Phase 43a — payment-term rule types (Xero-style "20th of next month") and
-- default terms per organization (sales / purchase) and per customer / vendor.
--
-- Retained on disk (rule 13): ledger_invoice_settings.default_due_days and
-- vendors.payment_terms. They are no longer the source of truth but earlier
-- migrations and backfills read them.
-- The purchase default is intentionally NOT backfilled (stays NULL).
--
-- FKs are composite (org_id, x) -> payment_terms (org_id, id) ON DELETE
-- RESTRICT: terms are never deleted (deactivated only), so RESTRICT never
-- fires, and SET NULL would null org_id of a composite key. MATCH SIMPLE lets
-- a NULL default satisfy the constraint.
--
-- Idempotent; the runner applies the file in one transaction.

ALTER TABLE payment_terms ADD COLUMN IF NOT EXISTS rule TEXT NOT NULL DEFAULT 'DAYS_AFTER_DATE';

ALTER TABLE payment_terms DROP CONSTRAINT IF EXISTS ck_payment_terms_rule;
ALTER TABLE payment_terms ADD CONSTRAINT ck_payment_terms_rule
  CHECK (rule IN ('DAYS_AFTER_DATE', 'DAYS_AFTER_MONTH_END', 'DAY_OF_NEXT_MONTH', 'DAY_OF_CURRENT_MONTH'));

ALTER TABLE payment_terms DROP CONSTRAINT IF EXISTS ck_payment_terms_rule_day;
ALTER TABLE payment_terms ADD CONSTRAINT ck_payment_terms_rule_day
  CHECK (rule NOT IN ('DAY_OF_NEXT_MONTH', 'DAY_OF_CURRENT_MONTH') OR net_days BETWEEN 1 AND 31);

ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS default_sales_payment_term_id UUID;
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS default_purchase_payment_term_id UUID;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_payment_term_id UUID;
ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS default_payment_term_id UUID;

ALTER TABLE ledger_settings DROP CONSTRAINT IF EXISTS fk_ledger_settings_default_sales_term;
ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_default_sales_term
  FOREIGN KEY (org_id, default_sales_payment_term_id) REFERENCES payment_terms (org_id, id) ON DELETE RESTRICT;

ALTER TABLE ledger_settings DROP CONSTRAINT IF EXISTS fk_ledger_settings_default_purchase_term;
ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_default_purchase_term
  FOREIGN KEY (org_id, default_purchase_payment_term_id) REFERENCES payment_terms (org_id, id) ON DELETE RESTRICT;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS fk_customers_default_payment_term;
ALTER TABLE customers ADD CONSTRAINT fk_customers_default_payment_term
  FOREIGN KEY (org_id, default_payment_term_id) REFERENCES payment_terms (org_id, id) ON DELETE RESTRICT;

ALTER TABLE vendors DROP CONSTRAINT IF EXISTS fk_vendors_default_payment_term;
ALTER TABLE vendors ADD CONSTRAINT fk_vendors_default_payment_term
  FOREIGN KEY (org_id, default_payment_term_id) REFERENCES payment_terms (org_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_settings_default_sales_term    ON ledger_settings (default_sales_payment_term_id);
CREATE INDEX IF NOT EXISTS idx_ledger_settings_default_purchase_term ON ledger_settings (default_purchase_payment_term_id);
CREATE INDEX IF NOT EXISTS idx_customers_default_payment_term        ON customers (default_payment_term_id);
CREATE INDEX IF NOT EXISTS idx_vendors_default_payment_term          ON vendors (default_payment_term_id);

-- Backfill 1: sales default from the invoice settings' default_due_days.
UPDATE ledger_settings s SET default_sales_payment_term_id = t.id
  FROM ledger_invoice_settings i
  JOIN payment_terms t ON t.org_id = i.org_id AND t.is_system AND t.is_active
                      AND t.rule = 'DAYS_AFTER_DATE' AND t.net_days = i.default_due_days
 WHERE s.org_id = i.org_id AND s.default_sales_payment_term_id IS NULL;

-- Backfill 2: vendor default from the free text, exact case-insensitive match on code or name.
UPDATE vendors v SET default_payment_term_id = t.id
  FROM payment_terms t
 WHERE t.org_id = v.org_id AND t.is_active AND v.default_payment_term_id IS NULL
   AND v.payment_terms IS NOT NULL
   AND (upper(btrim(v.payment_terms)) = t.code OR lower(btrim(v.payment_terms)) = lower(t.name));
