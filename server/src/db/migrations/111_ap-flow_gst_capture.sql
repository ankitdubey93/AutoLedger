-- Phase 49f — the bill inbox for an Australian organization.
--
-- supplier_abn is what the model read, unverified. tax_cents is GST printed for
-- a line, when the receipt prints it. tax_code is a reviewer's choice for a
-- receipt that mixes taxable and GST-free lines. All NULL elsewhere.
ALTER TABLE ap_flow_extractions ADD COLUMN IF NOT EXISTS supplier_abn TEXT NULL;
ALTER TABLE ap_flow_line_items
  ADD COLUMN IF NOT EXISTS tax_cents BIGINT NULL,
  ADD COLUMN IF NOT EXISTS tax_code TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ap_flow_line_items_tax_code') THEN
    ALTER TABLE ap_flow_line_items ADD CONSTRAINT chk_ap_flow_line_items_tax_code CHECK (
      tax_code IS NULL OR tax_code IN ('P_GST','P_CAP_GST','P_FREE','P_CAP_FREE','P_INPUT_TAXED','P_PRIVATE','P_EXCLUDED')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ap_flow_line_items_tax_cents') THEN
    ALTER TABLE ap_flow_line_items ADD CONSTRAINT chk_ap_flow_line_items_tax_cents CHECK (tax_cents IS NULL OR tax_cents >= 0);
  END IF;
END $$;
