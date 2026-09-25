-- 076_stock_gl_reconciliation.sql
-- Phase 35a — inventory ties out to the general ledger. Three pieces:
--
--   1. Two new movement types, RECLASS_OUT and RECLASS_IN: a value-only pair
--      (quantity_milli = 0) that moves an item's already-posted value between
--      two GL accounts without touching stock_balances (insertMovement's
--      balance UPDATE adds 0 net after both rows of the pair). This is the
--      only way the service layer is allowed to change which account an
--      item's on-hand value sits on — everything else about a movement's
--      qty/value pairing stays exactly as 067/072 defined it. The three
--      CHECK constraints below are widened, not replaced, the same
--      drop-if-stale / re-add-if-missing pattern 072 used so a replay
--      against an already-widened database is a no-op.
--
--   2. stock_gl_true_ups — an audit record of every journal that closes a
--      GL/subledger difference by moving the GL to match stock (Core model
--      §5: the true-up is a journal only, never the reverse). Append-only
--      like every other posted-money table (guardrails rule 6), with the
--      same immutability-trigger + audit-trigger pair stock_movements and
--      journal_entries already carry. account_id and journal_entry_id carry
--      no REFERENCES: rule 16 over rule 8, the same ruling 072 made for
--      stock_movements.gl_account_id (an inventory-side table cannot FK into
--      LedgerCore's accounts/journal_entries tables).
--
--   3. A one-time backfill: before this phase, itemService.linkProduct wrote
--      an opening journal into the GL but no stock_movements row recording
--      which account that value landed on, so pre-link on-hand value has
--      gl_account_id NULL and understates the control account (see
--      docs/roadmap.md Phase 32/35a). This repairs every item that was
--      linked before 35a with exactly one RECLASS pair, anchored on the
--      item's lowest (location_id, lot_id) balance row, valued at the
--      unaccounted sum and targeted at the account the opening journal
--      actually debited. The backfill is naturally idempotent: it only
--      considers items with no existing RECLASS_IN row sourced from that
--      item's own opening journal, so a second run finds nothing left to do.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere
-- below leaves the database untouched.

-- ----------------------------------------------------- stock_movements CHECKs

DO $$
BEGIN
  -- movement_type: add RECLASS_OUT / RECLASS_IN.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'stock_movements_movement_type_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%RECLASS_OUT%') THEN
    ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_movement_type_check') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
      CHECK (movement_type IN ('RECEIPT','ISSUE','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT_IN','ADJUSTMENT_OUT',
                               'RECEIPT_REVERSAL','ISSUE_REVERSAL','RECLASS_OUT','RECLASS_IN'));
  END IF;

  -- quantity_milli: a RECLASS pair is the one case quantity_milli = 0 is valid.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'stock_movements_quantity_milli_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%RECLASS_OUT%') THEN
    ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_quantity_milli_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_quantity_milli_check') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_quantity_milli_check
      CHECK ((quantity_milli <> 0 OR movement_type IN ('RECLASS_OUT','RECLASS_IN')) AND abs(quantity_milli) <= 1000000000);
  END IF;

  -- ck_stock_movements_sign: RECLASS_IN is qty 0 / value > 0 (entering the
  -- account); RECLASS_OUT is qty 0 / value < 0 (leaving it).
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'ck_stock_movements_sign'
                AND pg_get_constraintdef(oid) NOT LIKE '%RECLASS_OUT%') THEN
    ALTER TABLE stock_movements DROP CONSTRAINT ck_stock_movements_sign;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_stock_movements_sign') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movements_sign CHECK (
      (movement_type IN ('RECEIPT','TRANSFER_IN','ADJUSTMENT_IN','ISSUE_REVERSAL') AND quantity_milli > 0 AND value_cents >= 0)
      OR (movement_type IN ('ISSUE','TRANSFER_OUT','ADJUSTMENT_OUT','RECEIPT_REVERSAL') AND quantity_milli < 0 AND value_cents <= 0)
      OR (movement_type = 'RECLASS_IN' AND quantity_milli = 0 AND value_cents > 0)
      OR (movement_type = 'RECLASS_OUT' AND quantity_milli = 0 AND value_cents < 0));
  END IF;
END $$;

-- ------------------------------------------------------------- true-ups table

CREATE TABLE IF NOT EXISTS stock_gl_true_ups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  account_id       UUID NOT NULL,            -- accounts.id; no FK: rule 16 over rule 8 (072's ruling for gl_account_id)
  gl_before_cents  BIGINT NOT NULL,
  subledger_cents  BIGINT NOT NULL,
  difference_cents BIGINT NOT NULL CHECK (difference_cents <> 0),
  journal_entry_id UUID NOT NULL,            -- journal_entries.id; no FK, same ruling
  occurred_on      DATE NOT NULL,
  created_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_stock_gl_true_ups_arithmetic CHECK (difference_cents = gl_before_cents - subledger_cents)
);

CREATE INDEX IF NOT EXISTS idx_stock_gl_true_ups_org_created ON stock_gl_true_ups (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_gl_true_ups_created_by  ON stock_gl_true_ups (created_by);

CREATE OR REPLACE FUNCTION reject_stock_gl_true_up_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_gl_true_ups rows are immutable'
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_stock_gl_true_ups_immutable
  BEFORE UPDATE OR DELETE ON stock_gl_true_ups
  FOR EACH ROW EXECUTE FUNCTION reject_stock_gl_true_up_mutation();

CREATE OR REPLACE TRIGGER trg_stock_gl_true_ups_audit
  AFTER INSERT OR UPDATE OR DELETE ON stock_gl_true_ups
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('stock');

-- --------------------------------------------------- backfill of pre-link stock

-- Qualifying stock item i: linked to a LedgerCore product, holding
-- unaccounted (gl_account_id IS NULL) on-hand value from before this phase,
-- whose link wrote an opening journal (source_type = 'stock', source_id =
-- i.id — see stockGlService.postLinkOpeningOnClient), and with no RECLASS_IN
-- row already recording the repair (idempotency guard).
INSERT INTO stock_movements (
  id, org_id, movement_group_id, movement_type, item_id, location_id, lot_id, serial_id,
  quantity_milli, value_cents, reference, reason, source_type, source_id, gl_account_id,
  occurred_on, created_by
)
WITH qualifying AS (
  SELECT i.id AS item_id, i.org_id AS org_id, gen_random_uuid() AS group_id
    FROM stock_items i
   WHERE i.ledger_item_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM stock_movements m
        WHERE m.org_id = i.org_id AND m.item_id = i.id AND m.gl_account_id IS NULL
        GROUP BY m.item_id
       HAVING SUM(m.value_cents) > 0
     )
     AND EXISTS (
       SELECT 1 FROM journal_entries e
        WHERE e.org_id = i.org_id AND e.source_type = 'stock' AND e.source_id = i.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM stock_movements m2
        WHERE m2.org_id = i.org_id AND m2.item_id = i.id
          AND m2.movement_type = 'RECLASS_IN'
          AND m2.source_type = 'stock' AND m2.source_id = i.id
     )
),
sums AS (
  SELECT q.item_id, q.org_id, q.group_id, SUM(m.value_cents) AS s
    FROM qualifying q
    JOIN stock_movements m ON m.org_id = q.org_id AND m.item_id = q.item_id AND m.gl_account_id IS NULL
   GROUP BY q.item_id, q.org_id, q.group_id
),
entries AS (
  SELECT q.item_id, q.org_id, e.id AS entry_id, e.entry_date, e.created_by
    FROM qualifying q
    JOIN journal_entries e ON e.org_id = q.org_id AND e.source_type = 'stock' AND e.source_id = q.item_id
),
targets AS (
  SELECT en.item_id, en.org_id, en.entry_date, en.created_by,
         MIN(ll.account_id::text)::uuid AS account_id
    FROM entries en
    JOIN ledger_lines ll ON ll.org_id = en.org_id AND ll.journal_entry_id = en.entry_id AND ll.base_debit_cents > 0
   GROUP BY en.item_id, en.org_id, en.entry_date, en.created_by
),
anchors AS (
  SELECT DISTINCT ON (b.org_id, b.item_id)
         b.org_id, b.item_id, b.location_id, b.lot_id
    FROM stock_balances b
    JOIN qualifying q ON q.org_id = b.org_id AND q.item_id = b.item_id
   ORDER BY b.org_id, b.item_id, b.location_id, COALESCE(b.lot_id::text, '')
)
SELECT gen_random_uuid(), s.org_id, s.group_id, 'RECLASS_OUT', s.item_id, a.location_id, a.lot_id, NULL::uuid,
       0, -s.s, NULL::text, 'Link to general ledger (backfill)', NULL::text, NULL::uuid, NULL::uuid,
       t.entry_date, t.created_by
  FROM sums s
  JOIN targets t ON t.item_id = s.item_id AND t.org_id = s.org_id
  JOIN anchors a ON a.item_id = s.item_id AND a.org_id = s.org_id
UNION ALL
SELECT gen_random_uuid(), s.org_id, s.group_id, 'RECLASS_IN', s.item_id, a.location_id, a.lot_id, NULL::uuid,
       0, s.s, NULL::text, 'Link to general ledger (backfill)', 'stock', s.item_id, t.account_id,
       t.entry_date, t.created_by
  FROM sums s
  JOIN targets t ON t.item_id = s.item_id AND t.org_id = s.org_id
  JOIN anchors a ON a.item_id = s.item_id AND a.org_id = s.org_id;
