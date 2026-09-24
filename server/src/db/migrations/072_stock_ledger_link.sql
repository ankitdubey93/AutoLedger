-- 072_stock_ledger_link.sql
-- Phase 32 — connects StockLedger to LedgerCore's product master and general
-- ledger. Three pieces:
--
--   1. stock_items.ledger_item_id — the stock item's link to its LedgerCore
--      product (items.id). It lives on the DEPENDENT app's side: StockLedger
--      requires LedgerCore, so the pointer sits on the requirer. Unique per
--      org and frozen once set (a trigger), so a stock item can never be
--      re-pointed at a different product after movements have posted.
--      NO REFERENCES constraint — rule 16 (no app reads another app's
--      tables) overrides rule 8, the same ruling 032 made for AP-Flow's
--      account ids. The service layer validates the id and items are never
--      deleted (only deactivated).
--   2. stock_settings.default_location_id — the location a document line
--      falls back to when it names none. Same-app composite FK.
--   3. stock_movements provenance — source_type/source_id (mirroring
--      journal_entries), gl_account_id (the inventory account the movement's
--      value posted to; NULL = never touched the GL), and reverses_movement_id
--      with two new movement types, RECEIPT_REVERSAL and ISSUE_REVERSAL.
--      Movements stay append-only (067's trigger), so a void is a NEW row
--      pointing at the one it undoes, never an edit. A partial unique index
--      stops a movement being reversed twice.
--
-- ADD COLUMN does not fire 067's BEFORE UPDATE OR DELETE trigger, so the
-- append-only guarantee is untouched.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

-- --------------------------------------------------------------- stock_items

ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS ledger_item_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_items_org_ledger_item
  ON stock_items (org_id, ledger_item_id) WHERE ledger_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_stock_item_ledger_relink() RETURNS trigger AS $$
BEGIN
  IF OLD.ledger_item_id IS NOT NULL AND NEW.ledger_item_id IS DISTINCT FROM OLD.ledger_item_id THEN
    RAISE EXCEPTION 'a stock item''s LedgerCore product link cannot change once set'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_stock_items_ledger_link_frozen
  BEFORE UPDATE ON stock_items
  FOR EACH ROW EXECUTE FUNCTION reject_stock_item_ledger_relink();

-- ------------------------------------------------------------ stock_settings

ALTER TABLE stock_settings ADD COLUMN IF NOT EXISTS default_location_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_stock_settings_default_location') THEN
    ALTER TABLE stock_settings ADD CONSTRAINT fk_stock_settings_default_location
      FOREIGN KEY (org_id, default_location_id) REFERENCES stock_locations (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stock_settings_default_location ON stock_settings (default_location_id);

-- ----------------------------------------------------------- stock_movements

-- The composite self-FK below needs a unique (org_id, id) target.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_stock_movements_org_id_id') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT ux_stock_movements_org_id_id UNIQUE (org_id, id);
  END IF;
END $$;

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS source_type          TEXT;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS source_id            UUID;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS gl_account_id        UUID;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS reverses_movement_id UUID;

-- Widen the movement-type CHECK and the sign CHECK to admit the two reversal
-- types. 067 declared the type check inline, so PostgreSQL named it
-- stock_movements_movement_type_check; ck_stock_movements_sign is named.
-- Dropped and re-added under guards so a replay against a database that
-- already has the widened form is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'stock_movements_movement_type_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%RECEIPT_REVERSAL%') THEN
    ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_movement_type_check') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
      CHECK (movement_type IN ('RECEIPT','ISSUE','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT_IN','ADJUSTMENT_OUT',
                               'RECEIPT_REVERSAL','ISSUE_REVERSAL'));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'ck_stock_movements_sign'
                AND pg_get_constraintdef(oid) NOT LIKE '%RECEIPT_REVERSAL%') THEN
    ALTER TABLE stock_movements DROP CONSTRAINT ck_stock_movements_sign;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_stock_movements_sign') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movements_sign CHECK (
      (movement_type IN ('RECEIPT','TRANSFER_IN','ADJUSTMENT_IN','ISSUE_REVERSAL') AND quantity_milli > 0 AND value_cents >= 0)
      OR (movement_type IN ('ISSUE','TRANSFER_OUT','ADJUSTMENT_OUT','RECEIPT_REVERSAL') AND quantity_milli < 0 AND value_cents <= 0));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_stock_movements_source_pair') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movements_source_pair
      CHECK ((source_type IS NULL) = (source_id IS NULL)
             AND (source_type IS NULL OR length(source_type) BETWEEN 1 AND 40));
  END IF;

  -- reverses_movement_id is set exactly when the type is a reversal.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_stock_movements_reversal_link') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movements_reversal_link
      CHECK ((movement_type IN ('RECEIPT_REVERSAL','ISSUE_REVERSAL')) = (reverses_movement_id IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_stock_movements_reverses') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT fk_stock_movements_reverses
      FOREIGN KEY (org_id, reverses_movement_id) REFERENCES stock_movements (org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

-- A movement is reversed at most once (the journal_entries.reverses_entry_id pattern).
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_movements_reverses
  ON stock_movements (org_id, reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_org_source
  ON stock_movements (org_id, source_type, source_id) WHERE source_id IS NOT NULL;
