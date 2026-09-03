-- 004_ledger-core_journals.sql
-- Phase 3 — LedgerCore, the general ledger itself. See docs/schema.md and
-- docs/ledger-core.md#architectural-differentiation.
--
-- This file is where the project's central claim is made good: an unbalanced
-- journal entry cannot exist in this database, regardless of what wrote it.
-- The application checks the invariant too, but the application being correct
-- is not the reason the ledger balances.

-- ------------------------------------------------------------ journal_entries

CREATE TABLE IF NOT EXISTS journal_entries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT, deliberately NOT CASCADE. You cannot delete an organization that
  -- has posted journals: that is the correct accounting answer on its own, and
  -- it is also the only way immutability and cascade can coexist. A cascade
  -- would reach the BEFORE DELETE trigger below and abort mid-cascade; failing
  -- at the parent with a clear FK error is better than failing inside a trigger.
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- An audit reference: the user who posted this. RESTRICT so a user cannot be
  -- deleted out from under the entries they created.
  created_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- The accounting date, which is not the same as created_at. An entry posted
  -- on the 3rd may belong to the period ending the 31st of the month before.
  entry_date        DATE NOT NULL,
  description       TEXT,

  -- The hook every other app uses to post into the GL without touching these
  -- tables directly (guardrails rule 16). AP-Flow posts with
  -- source_type = 'ap_flow' and source_id pointing at its own document row.
  source_type       TEXT NOT NULL DEFAULT 'manual' CHECK (length(btrim(source_type)) > 0),
  source_id         UUID,

  -- Set on a reversing entry, pointing at the entry it reverses.
  reverses_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()

  -- NOTE: no updated_at, and no set_updated_at trigger. The row is immutable,
  -- so the column could never differ from created_at — it would be scaffolding
  -- implying a capability this table does not have.
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date
  ON journal_entries (org_id, entry_date);

-- Supports "find the GL entry for this AP-Flow document", the cross-app lookup.
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_source
  ON journal_entries (org_id, source_type, source_id);

-- An entry can be reversed at most once. Partial, because the overwhelming
-- majority of entries reverse nothing and NULLs would otherwise all collide.
-- This is what makes the double-reversal check race-safe; the application check
-- exists only to turn the resulting 23505 into a readable 409.
CREATE UNIQUE INDEX IF NOT EXISTS ux_journal_entries_reverses
  ON journal_entries (reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

-- --------------------------------------------------------------- ledger_lines

CREATE TABLE IF NOT EXISTS ledger_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Denormalised from the parent entry on purpose: every read is org-scoped,
  -- and carrying org_id here means a line query never has to join to prove
  -- tenancy (guardrails rule 1). RESTRICT for the same reason as the parent.
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  journal_entry_id  UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,

  -- Integer cents, never NUMERIC and never a float (guardrails rule 3).
  debit_cents       BIGINT NOT NULL DEFAULT 0 CHECK (debit_cents  >= 0),
  credit_cents      BIGINT NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),

  -- Multi-currency from the first row written. The FX *engine* is Phase 8, but
  -- these columns cannot wait for it: once a line exists without its native
  -- amount and the rate used, that information is gone and no later migration
  -- can reconstruct it. Until Phase 8 every line is written in the org's base
  -- currency at rate 1, so the base_* columns equal the native ones.
  currency_code     CHAR(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- NUMERIC, not a float: a rate is a ratio needing sub-cent precision, which
  -- is the documented exception to "money is BIGINT" — rates are not amounts.
  fx_rate           NUMERIC(18,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  base_debit_cents  BIGINT NOT NULL DEFAULT 0 CHECK (base_debit_cents  >= 0),
  base_credit_cents BIGINT NOT NULL DEFAULT 0 CHECK (base_credit_cents >= 0),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Guardrails rule 7: exactly one side populated. A CHECK sees a single row,
  -- which is all these need — the entry-level balance rule spans rows and is
  -- therefore a constraint trigger further down, not a CHECK.
  CONSTRAINT chk_line_nonzero
    CHECK (NOT (debit_cents = 0 AND credit_cents = 0)),
  CONSTRAINT chk_exclusive_debit_credit
    CHECK (NOT (debit_cents > 0 AND credit_cents > 0)),
  CONSTRAINT chk_base_nonzero
    CHECK (NOT (base_debit_cents = 0 AND base_credit_cents = 0)),
  CONSTRAINT chk_exclusive_base
    CHECK (NOT (base_debit_cents > 0 AND base_credit_cents > 0)),
  -- A line debited in its own currency must be debited in base currency too.
  -- Converting an amount can change its magnitude but never its side.
  CONSTRAINT chk_side_agrees_with_base
    CHECK ((debit_cents > 0) = (base_debit_cents > 0))
);

CREATE INDEX IF NOT EXISTS idx_ledger_lines_org_account
  ON ledger_lines (org_id, account_id);

CREATE INDEX IF NOT EXISTS idx_ledger_lines_entry
  ON ledger_lines (journal_entry_id);

-- ------------------------------------------------- the balance invariant

-- Sum of debits equals sum of credits, and an entry has at least two lines.
--
-- This cannot be a CHECK constraint: a CHECK evaluates one row, and this is a
-- property of every line belonging to an entry. It is a CONSTRAINT TRIGGER so
-- it can be DEFERRABLE INITIALLY DEFERRED and fire once at COMMIT — otherwise
-- inserting a two-line entry would fail on the first line, when the entry is
-- only transiently unbalanced.
--
-- Attached to BOTH tables. On ledger_lines it catches any change to the lines;
-- on journal_entries it closes the hole where a header is inserted with no
-- lines at all, which would never touch ledger_lines and so would never fire
-- the other trigger — and "debits equal credits" is vacuously true of nothing.
CREATE OR REPLACE FUNCTION assert_journal_entry_balanced() RETURNS trigger AS $$
DECLARE
  target_entry      UUID;
  total_debit       BIGINT;
  total_credit      BIGINT;
  total_base_debit  BIGINT;
  total_base_credit BIGINT;
  line_count        INTEGER;
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
         COUNT(*)
    INTO total_debit, total_credit, total_base_debit, total_base_credit, line_count
    FROM ledger_lines
   WHERE journal_entry_id = target_entry;

  IF line_count < 2 THEN
    RAISE EXCEPTION
      'journal entry % has % line(s); double-entry requires at least 2',
      target_entry, line_count;
  END IF;

  -- Integer equality. An epsilon here would be guardrails rule 3 violated at
  -- the one place it matters most, and it is the exact bug that sank the
  -- previous build.
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'journal entry % is unbalanced (debits=%, credits=%)',
      target_entry, total_debit, total_credit;
  END IF;

  IF total_base_debit <> total_base_credit THEN
    RAISE EXCEPTION
      'journal entry % is unbalanced in base currency (debits=%, credits=%)',
      target_entry, total_base_debit, total_base_credit;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- CONSTRAINT TRIGGER supports neither IF NOT EXISTS nor OR REPLACE, so the
-- DROP is what keeps this file replayable (guardrails rule 13).
DROP TRIGGER IF EXISTS trg_ledger_lines_balanced ON ledger_lines;
CREATE CONSTRAINT TRIGGER trg_ledger_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();

DROP TRIGGER IF EXISTS trg_journal_entries_have_lines ON journal_entries;
CREATE CONSTRAINT TRIGGER trg_journal_entries_have_lines
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();

-- ------------------------------------------------ postable-account guard

-- A header account (1000 Assets) is a reporting rollup and must never receive a
-- posting. The same lookup also enforces that the account belongs to the same
-- organization as the line — the tenancy boundary, checked by the database and
-- not only by the service (guardrails rule 1).
--
-- A plain BEFORE trigger, not deferred: this depends on one row only, so there
-- is no reason to wait for COMMIT to reject it.
CREATE OR REPLACE FUNCTION assert_account_is_postable() RETURNS trigger AS $$
DECLARE
  account_is_postable BOOLEAN;
  account_code        TEXT;
BEGIN
  SELECT is_postable, code
    INTO account_is_postable, account_code
    FROM accounts
   WHERE id = NEW.account_id
     AND org_id = NEW.org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'account % does not exist in organization %', NEW.account_id, NEW.org_id;
  END IF;

  IF NOT account_is_postable THEN
    RAISE EXCEPTION
      'account % is a header account and cannot be posted to', account_code;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ledger_lines_postable
  BEFORE INSERT ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION assert_account_is_postable();

-- ----------------------------------------------------------- immutability

-- Guardrails rule 6, enforced by the database rather than by convention.
-- Corrections are reversing entries (POST /journals/:id/reverse); there is no
-- route that could offer an update, and now no route that could be added by
-- mistake would work either.
--
-- ERRCODE 0A000 is feature_not_supported, which is exactly the claim: updating
-- a posted row is not a feature this schema has.
--
-- TRUNCATE does not fire row-level triggers, so test fixtures can still reset
-- the database between cases.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'posted ledger rows are immutable; post a reversing entry instead (guardrails rule 6)'
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE OR REPLACE TRIGGER trg_ledger_lines_immutable
  BEFORE UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
