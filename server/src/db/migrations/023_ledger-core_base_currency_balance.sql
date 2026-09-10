-- 023_ledger-core_base_currency_balance.sql
-- Phase 8 — LedgerCore multi-currency FX engine, part 2: base currency is
-- what balances. See docs/schema.md and
-- docs/ledger-core.md#d-multi-currency-fx-engine--phase-8.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched. This file does not edit 004 on disk — its
-- checksum is unchanged — it redefines the function 004 created, which every
-- trigger referencing it picks up automatically.

-- ------------------------------------------------- the balance invariant, v2

-- Base currency (the organization's functional currency) is the only one in
-- which an entry can meaningfully balance. A realized-FX settlement entry
-- legitimately holds a USD receivable line and an INR gain line in the same
-- entry — see docs/ledger-core.md's worked example — and summing those two
-- native amounts together would be adding apples to oranges. So:
--
--   * The BASE-currency sum check is now UNCONDITIONAL. Every entry, always,
--     must have SUM(base_debit_cents) = SUM(base_credit_cents).
--   * The NATIVE-currency sum check fires ONLY when every line in the entry
--     shares one currency_code. A single-currency entry (which is every
--     entry Phases 3 through 7 ever wrote, and every base-currency entry
--     this and future phases write) is still checked exactly as strictly as
--     before — this migration changes nothing observable for it.
--
-- This is the standard functional-currency accounting rule, not a workaround:
-- an entry that mixes currencies has no native "total" to speak of, only a
-- base-currency one. See study/postgresql/multi-currency-and-functional-currency.md.
CREATE OR REPLACE FUNCTION assert_journal_entry_balanced() RETURNS trigger AS $$
DECLARE
  target_entry      UUID;
  total_debit       BIGINT;
  total_credit      BIGINT;
  total_base_debit  BIGINT;
  total_base_credit BIGINT;
  line_count        INTEGER;
  currency_count    INTEGER;
BEGIN
  -- NEW is unassigned on DELETE and OLD is unassigned on INSERT, so the branch
  -- is required — COALESCE(NEW.x, OLD.x) would raise "record NEW is not
  -- assigned yet" rather than falling through.
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_entry := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_entry := OLD.journal_entry_id;
  ELSE
    target_entry := NEW.journal_entry_id;
  END IF;

  -- The entry itself may have been removed earlier in this same transaction,
  -- taking its lines with it by cascade. Nothing left to balance.
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = target_entry) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(debit_cents), 0),
         COALESCE(SUM(credit_cents), 0),
         COALESCE(SUM(base_debit_cents), 0),
         COALESCE(SUM(base_credit_cents), 0),
         COUNT(*),
         COUNT(DISTINCT currency_code)
    INTO total_debit, total_credit, total_base_debit, total_base_credit, line_count, currency_count
    FROM ledger_lines
   WHERE journal_entry_id = target_entry;

  IF line_count < 2 THEN
    RAISE EXCEPTION
      'journal entry % has % line(s); double-entry requires at least 2',
      target_entry, line_count;
  END IF;

  -- Native-currency check: only meaningful, and only enforced, when every
  -- line in the entry is denominated in one currency. Integer equality, no
  -- epsilon (guardrails rule 3) — unchanged from 004 for every entry this
  -- branch still covers.
  IF currency_count = 1 AND total_debit <> total_credit THEN
    RAISE EXCEPTION
      'journal entry % is unbalanced (debits=%, credits=%)',
      target_entry, total_debit, total_credit;
  END IF;

  -- Base-currency check: unconditional. This is the invariant that actually
  -- protects the books once more than one currency exists in the system.
  IF total_base_debit <> total_base_credit THEN
    RAISE EXCEPTION
      'journal entry % is unbalanced in base currency (debits=%, credits=%)',
      target_entry, total_base_debit, total_base_credit;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The two CONSTRAINT TRIGGERs from 004 already point at this function by
-- name; CREATE OR REPLACE FUNCTION is enough for them to pick up the new
-- body. Re-creating the CONSTRAINT TRIGGERs here would be a second,
-- redundant definition — CONSTRAINT TRIGGER supports neither IF NOT EXISTS
-- nor OR REPLACE, and DROP + CREATE-ing them again buys nothing since their
-- shape (timing, table, DEFERRABLE INITIALLY DEFERRED) is unchanged.

-- --------------------------------------------- native/base agreement, by CHECK

-- Every existing row was written at fx_rate = 1, so base_* already equals
-- native * 1 for all of it — this validates against the whole table with no
-- backfill. round(numeric) rounds half away from zero, the same rule
-- scaleCents (utils/money.ts, via utils/fxRate.ts's convertToBase) applies
-- for the non-negative amounts every ledger line holds — the identity that
-- lets the service and the database agree on the same number to the cent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ledger_lines_base_matches_rate') THEN
    ALTER TABLE ledger_lines ADD CONSTRAINT chk_ledger_lines_base_matches_rate
      CHECK (base_debit_cents  = round(debit_cents  * fx_rate)
         AND base_credit_cents = round(credit_cents * fx_rate));
  END IF;
END $$;
