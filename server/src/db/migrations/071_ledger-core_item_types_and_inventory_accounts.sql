-- 071_ledger-core_item_types_and_inventory_accounts.sql
-- Phase 32 — one product master for the suite. LedgerCore's `items` table
-- (059) becomes "Products & Services": each row gains an item TYPE, and the
-- inventory-relevant types carry the accounts their stock posts to.
--
--   SERVICE        created in LedgerCore; revenue/expense account only
--   NON_INVENTORY  created in LedgerCore; bought/sold, no quantity tracked
--   INVENTORY      created in StockLedger (which creates this row too);
--                  posts to an inventory-asset account and a COGS account
--   FIXED_ASSET    reserved for Phase 32 step 2; nothing can create one yet,
--                  but it is in the CHECK now so step 2 needs no migration
--
-- `kind` (059) stays — an applied migration is never edited (rule 13) — and
-- a CHECK keeps it consistent with item_type: kind is SERVICE exactly when
-- item_type is SERVICE, GOODS otherwise. The service writes kind FROM
-- item_type and never independently.
--
-- Also here: the four ledger_settings accounts inventory posting falls back
-- to, the per-line stock location on invoice/bill lines, and two new
-- postable accounts (5050, 5400) seeded for existing organizations.
--
-- stock_location_id on the line tables carries NO REFERENCES constraint:
-- stock_locations belongs to StockLedger, and rule 16 (no app reads another
-- app's tables) overrides rule 8 for a cross-app pointer — the same ruling
-- 032 (accounts) and 049 (bill_id / journal_entry_id) made in the other
-- direction. Validity is checked by the service that uses it.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

-- ------------------------------------------------------------ items: type

ALTER TABLE items ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'NON_INVENTORY';

-- Backfill: SERVICE stays SERVICE, GOODS becomes NON_INVENTORY (the column
-- default already did the second half). Safe to replay.
UPDATE items SET item_type = 'SERVICE' WHERE kind = 'SERVICE' AND item_type <> 'SERVICE';

ALTER TABLE items ALTER COLUMN item_type DROP DEFAULT;

ALTER TABLE items ADD COLUMN IF NOT EXISTS asset_account_id UUID;
ALTER TABLE items ADD COLUMN IF NOT EXISTS cogs_account_id  UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_items_item_type') THEN
    ALTER TABLE items ADD CONSTRAINT ck_items_item_type
      CHECK (item_type IN ('SERVICE', 'NON_INVENTORY', 'INVENTORY', 'FIXED_ASSET'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_items_kind_matches_type') THEN
    ALTER TABLE items ADD CONSTRAINT ck_items_kind_matches_type
      CHECK ((kind = 'SERVICE') = (item_type = 'SERVICE'));
  END IF;

  -- Inventory/asset accounts only make sense on a stock-managed item.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_items_stock_accounts') THEN
    ALTER TABLE items ADD CONSTRAINT ck_items_stock_accounts
      CHECK (item_type IN ('INVENTORY', 'FIXED_ASSET')
             OR (asset_account_id IS NULL AND cogs_account_id IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_items_asset_account') THEN
    ALTER TABLE items ADD CONSTRAINT fk_items_asset_account
      FOREIGN KEY (org_id, asset_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_items_cogs_account') THEN
    ALTER TABLE items ADD CONSTRAINT fk_items_cogs_account
      FOREIGN KEY (org_id, cogs_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_items_asset_account  ON items (asset_account_id);
CREATE INDEX IF NOT EXISTS idx_items_cogs_account   ON items (cogs_account_id);
CREATE INDEX IF NOT EXISTS idx_items_org_type_active ON items (org_id, item_type, is_active, code);

-- ------------------------------------------------ document lines: location

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS stock_location_id UUID;
ALTER TABLE bill_lines    ADD COLUMN IF NOT EXISTS stock_location_id UUID;

-- ------------------------------------------------ ledger_settings: accounts

ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS inventory_account_id            UUID;
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS cogs_account_id                 UUID;
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS inventory_adjustment_account_id UUID;
ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS stock_opening_account_id        UUID;

-- Composite FKs, RESTRICT — the reasoning 012 gives for its own three.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_inventory_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_inventory_account
      FOREIGN KEY (org_id, inventory_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_cogs_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_cogs_account
      FOREIGN KEY (org_id, cogs_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_inventory_adjustment_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_inventory_adjustment_account
      FOREIGN KEY (org_id, inventory_adjustment_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_settings_stock_opening_account') THEN
    ALTER TABLE ledger_settings ADD CONSTRAINT fk_ledger_settings_stock_opening_account
      FOREIGN KEY (org_id, stock_opening_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ledger_settings_inventory_account            ON ledger_settings (inventory_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_settings_cogs_account                 ON ledger_settings (cogs_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_settings_inventory_adjustment_account ON ledger_settings (inventory_adjustment_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_settings_stock_opening_account        ON ledger_settings (stock_opening_account_id);

-- ---------------------------------------------- default chart: 5050 and 5400
-- 5000 Cost of Goods Sold is a NON-postable header, so inventory posting needs
-- a postable child of its own. Modelled on 028: the EXISTS guard stops an
-- organization with no chart receiving orphan rows, and ON CONFLICT skips an
-- org whose imported chart already uses the code (the posting-time resolver
-- validates type and postability, so it never posts to a wrong account).
-- accountService.DEFAULT_CHART gains the same two rows for new organizations.

INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT o.id, '5050', 'Cost of Sales — Inventory', 'Expense', true,
       (SELECT p.id FROM accounts p WHERE p.org_id = o.id AND p.code = '5000')
  FROM organizations o
 WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '5000')
ON CONFLICT (org_id, code) DO NOTHING;

INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
SELECT o.id, '5400', 'Inventory Adjustments & Shrinkage', 'Expense', true,
       (SELECT p.id FROM accounts p WHERE p.org_id = o.id AND p.code = '5000')
  FROM organizations o
 WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '5000')
ON CONFLICT (org_id, code) DO NOTHING;
