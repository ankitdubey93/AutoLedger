-- 026_ledger-core_fx_revaluations.sql
-- Phase 8 — LedgerCore multi-currency FX engine, part 5: period-end
-- unrealized revaluation. See docs/schema.md and
-- docs/ledger-core.md#d-multi-currency-fx-engine--phase-8.
--
-- Every statement is idempotent, and the runner applies the file in a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.
--
-- A revaluation is created posted and stays posted forever — there is
-- deliberately no status column and no FSM here (unlike every other
-- lifecycle table in this schema). A wrong revaluation is corrected by the
-- next period's revaluation, the same way an accountant would, not by
-- editing or voiding this one. Its own GL entry carries an automatic
-- next-day reversal (posted by fxRevaluationService.runRevaluation, a second
-- call to journalService.reverseEntryOnClient, not a database trigger) so
-- realized FX at settlement always compares against a document's original
-- frozen rate, never a revalued carrying amount.

CREATE TABLE IF NOT EXISTS fx_revaluations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  as_of_date                DATE NOT NULL,
  journal_entry_id          UUID NOT NULL,
  reversal_journal_entry_id UUID NOT NULL,

  -- Signed — a revaluation delta is not a "money >= 0" amount, matching
  -- bank_transactions.amount_cents rather than every other BIGINT column in
  -- this schema.
  total_delta_cents         BIGINT NOT NULL,
  line_count                INTEGER NOT NULL CHECK (line_count > 0),

  created_by                UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_fx_revaluations_org_id_id UNIQUE (org_id, id),
  -- At most one revaluation per organization per date — POST /fx-revaluations
  -- turns the resulting 23505 into a readable 409.
  CONSTRAINT ux_fx_revaluations_org_date  UNIQUE (org_id, as_of_date),
  CONSTRAINT fk_fx_revaluations_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fx_revaluations_reversal
    FOREIGN KEY (org_id, reversal_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fx_revaluations_org_date ON fx_revaluations (org_id, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_fx_revaluations_entry     ON fx_revaluations (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_fx_revaluations_reversal  ON fx_revaluations (reversal_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_fx_revaluations_created_by ON fx_revaluations (created_by);

-- -------------------------------------------------------- fx_revaluation_lines

CREATE TABLE IF NOT EXISTS fx_revaluation_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  revaluation_id     UUID NOT NULL,

  invoice_id         UUID,
  bill_id            UUID,

  currency_code      CHAR(3) NOT NULL,
  outstanding_cents  BIGINT NOT NULL CHECK (outstanding_cents > 0),
  document_rate      NUMERIC(18,8) NOT NULL CHECK (document_rate > 0),
  revaluation_rate    NUMERIC(18,8) NOT NULL CHECK (revaluation_rate > 0),
  carrying_base_cents BIGINT NOT NULL CHECK (carrying_base_cents >= 0),
  revalued_base_cents BIGINT NOT NULL CHECK (revalued_base_cents >= 0),
  -- Signed, like the parent's total_delta_cents.
  delta_cents         BIGINT NOT NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_fx_revaluation_line_one_target CHECK (
    (invoice_id IS NOT NULL AND bill_id IS NULL) OR
    (invoice_id IS NULL AND bill_id IS NOT NULL)
  ),
  CONSTRAINT fk_fx_revaluation_line_revaluation
    FOREIGN KEY (org_id, revaluation_id) REFERENCES fx_revaluations (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_fx_revaluation_line_invoice
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_fx_revaluation_line_bill
    FOREIGN KEY (org_id, bill_id) REFERENCES bills (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_fx_revaluation_lines_revaluation ON fx_revaluation_lines (revaluation_id);
CREATE INDEX IF NOT EXISTS idx_fx_revaluation_lines_invoice     ON fx_revaluation_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_fx_revaluation_lines_bill        ON fx_revaluation_lines (bill_id);

-- Phase 5's audit_row_change() on the parent only — the detail lines are
-- derived from open documents at the moment the revaluation ran and are
-- never regenerated in place (unlike bank_match_suggestions, which really is
-- deleted and rewritten wholesale on every rescore); the parent row is the
-- single compliance-relevant fact, and its own delta already summarizes them.
CREATE OR REPLACE TRIGGER trg_fx_revaluations_audit
  AFTER INSERT OR UPDATE OR DELETE ON fx_revaluations
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
