-- Phase 47 — an optional current/non-current override for Asset and Liability
-- accounts. NULL means "derive it from the chart tree" (utils/balanceSheetClass.ts):
-- under 1400 / 2500 is NON_CURRENT, everything else CURRENT. Not a sixth account type (rule 12).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance_sheet_class TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_balance_sheet_class') THEN
    ALTER TABLE accounts
      ADD CONSTRAINT chk_accounts_balance_sheet_class CHECK (
        balance_sheet_class IS NULL
        OR (balance_sheet_class IN ('CURRENT', 'NON_CURRENT')
            AND type IN ('Asset', 'Liability'))
      );
  END IF;
END $$;
