-- Phase 45 — review decisions for the GL exception report. A review is not a
-- financial document: reopening a flag deletes its row (audit_logs keeps it).
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_lines_org_id_id ON ledger_lines (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_lines_org_id_id ON invoice_lines (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bill_lines_org_id_id ON bill_lines (org_id, id);

CREATE TABLE IF NOT EXISTS gl_exception_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  rule_code         TEXT NOT NULL CHECK (rule_code IN ('UNUSUAL_AMOUNT', 'UNEXPECTED_SIDE', 'NON_DEFAULT_TAX', 'POSSIBLE_DUPLICATE')),
  ledger_line_id    UUID NULL,
  journal_entry_id  UUID NULL,
  invoice_line_id   UUID NULL,
  bill_line_id      UUID NULL,
  note              TEXT NOT NULL CHECK (length(btrim(note)) > 0 AND length(note) <= 500),
  reviewed_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_gl_exception_reviews_one_subject
    CHECK (num_nonnulls(ledger_line_id, journal_entry_id, invoice_line_id, bill_line_id) = 1),
  CONSTRAINT chk_gl_exception_reviews_subject_matches_rule CHECK (
       (rule_code IN ('UNUSUAL_AMOUNT', 'UNEXPECTED_SIDE') AND ledger_line_id IS NOT NULL)
    OR (rule_code = 'POSSIBLE_DUPLICATE' AND journal_entry_id IS NOT NULL)
    OR (rule_code = 'NON_DEFAULT_TAX' AND (invoice_line_id IS NOT NULL OR bill_line_id IS NOT NULL))
  ),
  CONSTRAINT fk_gl_exception_reviews_ledger_line
    FOREIGN KEY (org_id, ledger_line_id) REFERENCES ledger_lines (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_gl_exception_reviews_journal_entry
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_gl_exception_reviews_invoice_line
    FOREIGN KEY (org_id, invoice_line_id) REFERENCES invoice_lines (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_gl_exception_reviews_bill_line
    FOREIGN KEY (org_id, bill_line_id) REFERENCES bill_lines (org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_exception_reviews_ledger_line
  ON gl_exception_reviews (org_id, rule_code, ledger_line_id) WHERE ledger_line_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_exception_reviews_journal_entry
  ON gl_exception_reviews (org_id, rule_code, journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_exception_reviews_invoice_line
  ON gl_exception_reviews (org_id, rule_code, invoice_line_id) WHERE invoice_line_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_gl_exception_reviews_bill_line
  ON gl_exception_reviews (org_id, rule_code, bill_line_id) WHERE bill_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_exception_reviews_org ON gl_exception_reviews (org_id);
CREATE INDEX IF NOT EXISTS idx_gl_exception_reviews_reviewed_by ON gl_exception_reviews (reviewed_by);

CREATE OR REPLACE TRIGGER trg_gl_exception_reviews_audit
  AFTER INSERT OR UPDATE OR DELETE ON gl_exception_reviews
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
