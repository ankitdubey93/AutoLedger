-- 075_ledger-core_recurring_schedules.sql
-- Phase 34b — recurring documents. An invoice, bill or manual journal entry
-- acts as a template; a background sweep (recurringService.runDueOccurrences,
-- queue/handlers/recurringSweepHandler.ts) generates the next occurrence on
-- schedule, as a draft or posted document, exactly once per due date. A
-- recurring journal can additionally post its own reversal dated the first
-- day of the next month. See plans/phase-34-automation-rules.md.
--
-- Three nullable source columns instead of a polymorphic source_id: rule 8
-- requires every `*_id` to carry a real FK, and a single `source_id` would
-- have to point at three different tables depending on `kind` — exactly the
-- ai_model_calls.entity_id (051) shape this codebase deliberately avoids for
-- anything that is not a cross-app platform table. `chk_recurring_source_matches_kind`
-- makes "the wrong column set for this kind" unrepresentable at the database
-- level, not just in the service.
--
-- A schedule is never deleted, only ended (status = 'ENDED', next_run_date =
-- NULL) — recurring_runs' `fk_recurring_runs_schedule` is ON DELETE RESTRICT,
-- so a schedule with history literally cannot be removed. That mirrors why a
-- bank rule (074) is deactivated rather than deleted.
--
-- Exactly-once generation is enforced two ways together: `runDueOccurrences`
-- takes `recurring_schedules ... FOR UPDATE SKIP LOCKED` before generating
-- (so two sweep ticks racing on the same schedule never both fire), and
-- `ux_recurring_runs_schedule_date` makes a second row for the same schedule
-- and run_date a constraint violation even if that lock discipline were ever
-- bypassed by a bug — belt and braces, the same reasoning rule 7's CHECK
-- constraints get alongside service-level validation.

CREATE TABLE IF NOT EXISTS recurring_schedules (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  kind                     TEXT NOT NULL CHECK (kind IN ('INVOICE', 'BILL', 'JOURNAL')),
  name                     TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 80),
  source_invoice_id        UUID NULL,
  source_bill_id           UUID NULL,
  source_journal_entry_id  UUID NULL,
  frequency                TEXT NOT NULL CHECK (frequency IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')),
  interval_count           SMALLINT NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 12),
  start_date               DATE NOT NULL,
  end_date                 DATE NULL,
  next_run_date            DATE NULL,
  next_occurrence_index    INTEGER NOT NULL DEFAULT 0 CHECK (next_occurrence_index >= 0),
  mode                     TEXT NOT NULL DEFAULT 'DRAFT' CHECK (mode IN ('DRAFT', 'POST')),
  auto_reverse             BOOLEAN NOT NULL DEFAULT false,
  status                   TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'ENDED')),
  last_error               TEXT NULL CHECK (last_error IS NULL OR length(last_error) <= 500),
  last_error_at            TIMESTAMPTZ NULL,
  created_by               UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_recurring_schedules_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_recurring_source_matches_kind CHECK (
       (kind = 'INVOICE' AND source_invoice_id IS NOT NULL AND source_bill_id IS NULL AND source_journal_entry_id IS NULL)
    OR (kind = 'BILL'    AND source_bill_id IS NOT NULL AND source_invoice_id IS NULL AND source_journal_entry_id IS NULL)
    OR (kind = 'JOURNAL' AND source_journal_entry_id IS NOT NULL AND source_invoice_id IS NULL AND source_bill_id IS NULL)),
  CONSTRAINT chk_recurring_journal_posts CHECK (kind <> 'JOURNAL' OR mode = 'POST'),
  CONSTRAINT chk_recurring_auto_reverse_journal_only CHECK (NOT auto_reverse OR kind = 'JOURNAL'),
  CONSTRAINT chk_recurring_end_after_start CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT chk_recurring_ended_has_no_next CHECK ((status = 'ENDED') = (next_run_date IS NULL)),
  CONSTRAINT fk_recurring_source_invoice FOREIGN KEY (org_id, source_invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_source_bill FOREIGN KEY (org_id, source_bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_source_journal FOREIGN KEY (org_id, source_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_recurring_schedules_due ON recurring_schedules (next_run_date) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_recurring_schedules_org_kind ON recurring_schedules (org_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_recurring_schedules_source_invoice ON recurring_schedules (source_invoice_id);
CREATE INDEX IF NOT EXISTS idx_recurring_schedules_source_bill ON recurring_schedules (source_bill_id);
CREATE INDEX IF NOT EXISTS idx_recurring_schedules_source_journal ON recurring_schedules (source_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_recurring_schedules_created_by ON recurring_schedules (created_by);

CREATE OR REPLACE TRIGGER trg_recurring_schedules_updated_at BEFORE UPDATE ON recurring_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_recurring_schedules_audit AFTER INSERT OR UPDATE OR DELETE ON recurring_schedules
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE TABLE IF NOT EXISTS recurring_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  schedule_id        UUID NOT NULL,
  run_date           DATE NOT NULL,
  occurrence_number  INTEGER NOT NULL CHECK (occurrence_number >= 1),
  invoice_id         UUID NULL,
  bill_id            UUID NULL,
  journal_entry_id   UUID NULL,
  reversal_entry_id  UUID NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_recurring_runs_schedule_date UNIQUE (schedule_id, run_date),
  CONSTRAINT chk_recurring_runs_one_document CHECK (num_nonnulls(invoice_id, bill_id, journal_entry_id) = 1),
  CHECK (reversal_entry_id IS NULL OR journal_entry_id IS NOT NULL),
  CONSTRAINT fk_recurring_runs_schedule FOREIGN KEY (org_id, schedule_id) REFERENCES recurring_schedules (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_runs_invoice FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_runs_bill FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_runs_journal_entry FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurring_runs_reversal_entry FOREIGN KEY (org_id, reversal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_recurring_runs_org_schedule ON recurring_runs (org_id, schedule_id);
CREATE INDEX IF NOT EXISTS idx_recurring_runs_invoice ON recurring_runs (invoice_id);
CREATE INDEX IF NOT EXISTS idx_recurring_runs_bill ON recurring_runs (bill_id);
CREATE INDEX IF NOT EXISTS idx_recurring_runs_journal_entry ON recurring_runs (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_recurring_runs_reversal_entry ON recurring_runs (reversal_entry_id);

-- Append-only: a run is a record of what the sweep actually did. Not on
-- DELETE — an org cascade (organizations -> recurring_schedules -> here, all
-- RESTRICT in this migration, but a future org-deletion path must still be
-- able to remove these rows wholesale) matches the ai_model_calls (051)
-- BEFORE UPDATE-only precedent.
CREATE OR REPLACE FUNCTION reject_recurring_run_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Recurring run % is history and cannot be changed', OLD.id
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_recurring_runs_append_only BEFORE UPDATE ON recurring_runs
  FOR EACH ROW EXECUTE FUNCTION reject_recurring_run_update();
