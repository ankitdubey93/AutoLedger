-- 016_ledger-core_period_posting_guard.sql
-- Phase 4 — postings into a closed fiscal period are refused by the database.
--
-- The same doctrine as 004's balance trigger: the service checks this too
-- (fiscalPeriodService.assertPeriodOpenOnClient), and the service being
-- correct is not the reason a closed month stays closed.
--
-- A date covered by NO period is open. Absence of a period is not a lock —
-- an organization that has never generated periods must keep posting.
--
-- Attached to BOTH tables, like 004's balance trigger. On journal_entries it
-- catches the normal path; on ledger_lines it closes the hole where a line
-- is added to an entry that already exists in a period since closed.
--
-- A plain BEFORE trigger, not deferred: this depends on one row and one
-- lookup, so there is no reason to wait for COMMIT to reject it.

CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE
  target_org    UUID;
  target_date   DATE;
  period_status TEXT;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_org  := NEW.org_id;
    target_date := NEW.entry_date;
  ELSE
    SELECT e.org_id, e.entry_date
      INTO target_org, target_date
      FROM journal_entries e
     WHERE e.id = NEW.journal_entry_id;

    -- No parent entry: 004's deferred balance trigger owns that failure.
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  -- The EXCLUDE constraint in 015 guarantees at most one period can match,
  -- so a bare SELECT INTO cannot be ambiguous here.
  SELECT p.status
    INTO period_status
    FROM fiscal_periods p
   WHERE p.org_id = target_org
     AND target_date BETWEEN p.starts_on AND p.ends_on;

  IF FOUND AND period_status <> 'OPEN' THEN
    RAISE EXCEPTION
      'the fiscal period covering % is %; postings into a closed period are not permitted',
      target_date, lower(period_status);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_journal_entries_period_open
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();

CREATE OR REPLACE TRIGGER trg_ledger_lines_period_open
  BEFORE INSERT ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();
