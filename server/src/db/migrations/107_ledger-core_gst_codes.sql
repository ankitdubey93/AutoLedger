-- Phase 49b — GST codes on document lines, and tax-inclusive pricing.
--
-- tax_code is a snapshot beside tax_rate_bp, not a foreign key: codes are a
-- closed catalogue in config/taxPacks/au.ts, and a posted line must keep what
-- it was issued with. NULL means the line belongs to a GENERIC organization,
-- or to a draft from before it became Australian.
--
-- A new nullable column and a constant default rewrite no rows, and the
-- posted-row immutability triggers fire only on row writes, so this touches
-- no posted document.
DO $$
DECLARE
  sales_codes CONSTANT TEXT := $c$'S_GST','S_EXPORT','S_FREE','S_INPUT_TAXED','S_EXCLUDED'$c$;
  purchase_codes CONSTANT TEXT := $c$'P_GST','P_CAP_GST','P_FREE','P_CAP_FREE','P_INPUT_TAXED','P_PRIVATE','P_EXCLUDED'$c$;
  all_codes CONSTANT TEXT := sales_codes || ',' || purchase_codes;
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('invoice_lines', sales_codes),
      ('credit_note_lines', sales_codes),
      ('bill_lines', purchase_codes),
      ('debit_note_lines', purchase_codes),
      ('quote_lines', all_codes),
      ('order_lines', all_codes)
    ) AS t(table_name, codes)
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tax_code TEXT NULL', spec.table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_' || spec.table_name || '_tax_code') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (tax_code IS NULL OR tax_code IN (%s))',
        spec.table_name, 'chk_' || spec.table_name || '_tax_code', spec.codes
      );
    END IF;
  END LOOP;

  FOR spec IN
    SELECT * FROM (VALUES ('invoices'), ('credit_notes'), ('bills'), ('debit_notes'), ('quotes'), ('orders')) AS t(table_name)
  LOOP
    EXECUTE format($f$ALTER TABLE %I ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'EXCLUSIVE'$f$, spec.table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_' || spec.table_name || '_tax_mode') THEN
      EXECUTE format(
        $f$ALTER TABLE %I ADD CONSTRAINT %I CHECK (tax_mode IN ('EXCLUSIVE', 'INCLUSIVE'))$f$,
        spec.table_name, 'chk_' || spec.table_name || '_tax_mode'
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'sale_tax_code') THEN
    ALTER TABLE items ADD COLUMN sale_tax_code TEXT NULL, ADD COLUMN purchase_tax_code TEXT NULL;
    EXECUTE format('ALTER TABLE items ADD CONSTRAINT chk_items_sale_tax_code CHECK (sale_tax_code IS NULL OR sale_tax_code IN (%s))', sales_codes);
    EXECUTE format('ALTER TABLE items ADD CONSTRAINT chk_items_purchase_tax_code CHECK (purchase_tax_code IS NULL OR purchase_tax_code IN (%s))', purchase_codes);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'default_tax_code') THEN
    ALTER TABLE accounts ADD COLUMN default_tax_code TEXT NULL;
    EXECUTE format('ALTER TABLE accounts ADD CONSTRAINT chk_accounts_default_tax_code CHECK (default_tax_code IS NULL OR default_tax_code IN (%s))', all_codes);
  END IF;
END $$;
