-- Phase 45 — an optional cash-flow classification override for balance-sheet
-- accounts. NULL means "derive it" (cashFlowService). Not a sixth account type (rule 12).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cash_flow_category TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_cash_flow_category') THEN
    ALTER TABLE accounts
      ADD CONSTRAINT chk_accounts_cash_flow_category CHECK (
        cash_flow_category IS NULL
        OR (cash_flow_category IN ('CASH', 'OPERATING', 'INVESTING', 'FINANCING')
            AND type IN ('Asset', 'Liability', 'Equity'))
      );
  END IF;
END $$;

-- Accumulated depreciation sits under 1400 Non-Current Assets, which derives
-- to INVESTING; depreciation is a non-cash add-back, so it is OPERATING.
UPDATE accounts
   SET cash_flow_category = 'OPERATING'
 WHERE code = '1590' AND name = 'Accumulated Depreciation' AND type = 'Asset'
   AND cash_flow_category IS NULL;
