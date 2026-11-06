-- Phase 49d — the Business Activity Statement.
--
-- basis, method and cycle are frozen on the return when it is created, so a
-- later change in GST settings cannot alter one. DRAFT computes live.
-- FINALISED stores labels and contributing events, never recomputed, and can be
-- reopened. LODGED is immutable: an error is corrected on a later return.
CREATE TABLE IF NOT EXISTS bas_returns (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start              DATE NOT NULL,
  period_end                DATE NOT NULL,
  basis                     TEXT NOT NULL CHECK (basis IN ('CASH', 'ACCRUAL')),
  method                    TEXT NOT NULL CHECK (method IN ('SIMPLER', 'FULL')),
  cycle                     TEXT NOT NULL CHECK (cycle IN ('QUARTERLY', 'MONTHLY')),
  status                    TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINALISED', 'LODGED')),
  due_date                  DATE NOT NULL,
  -- PAYG figures typed on the return. There is no payroll module.
  w1_cents                  BIGINT NOT NULL DEFAULT 0 CHECK (w1_cents >= 0),
  w2_cents                  BIGINT NOT NULL DEFAULT 0 CHECK (w2_cents >= 0),
  instalment_cents          BIGINT NOT NULL DEFAULT 0 CHECK (instalment_cents >= 0),
  lodged_on                 DATE,
  ato_reference             TEXT CHECK (ato_reference IS NULL OR length(ato_reference) <= 100),
  clearing_journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by                UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  finalised_by              UUID REFERENCES users(id) ON DELETE RESTRICT,
  finalised_at              TIMESTAMPTZ,
  lodged_by                 UUID REFERENCES users(id) ON DELETE RESTRICT,
  lodged_at                 TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_bas_returns_org_id_id UNIQUE (org_id, id),
  CONSTRAINT chk_bas_returns_period CHECK (period_end > period_start),
  CONSTRAINT chk_bas_returns_lodged CHECK (status <> 'LODGED' OR lodged_on IS NOT NULL),
  CONSTRAINT ex_bas_returns_no_overlap EXCLUDE USING GIST (
    org_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS idx_bas_returns_org_period ON bas_returns (org_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_bas_returns_clearing ON bas_returns (clearing_journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bas_returns_created_by ON bas_returns (created_by);
CREATE INDEX IF NOT EXISTS idx_bas_returns_finalised_by ON bas_returns (finalised_by);
CREATE INDEX IF NOT EXISTS idx_bas_returns_lodged_by ON bas_returns (lodged_by);

CREATE TABLE IF NOT EXISTS bas_return_labels (
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bas_return_id UUID NOT NULL,
  label         TEXT NOT NULL CHECK (length(label) <= 10),
  cents         BIGINT NOT NULL,
  PRIMARY KEY (bas_return_id, label),
  CONSTRAINT fk_bas_return_labels_return FOREIGN KEY (org_id, bas_return_id)
    REFERENCES bas_returns (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bas_return_labels_org ON bas_return_labels (org_id, bas_return_id);

CREATE TABLE IF NOT EXISTS bas_return_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bas_return_id    UUID NOT NULL,
  source_kind      TEXT NOT NULL CHECK (source_kind IN ('INVOICE', 'CREDIT_NOTE', 'BILL', 'DEBIT_NOTE', 'JOURNAL')),
  -- Polymorphic by source_kind, like journal_entries.source_id; no foreign key.
  source_ref       UUID NOT NULL,
  document_number  TEXT,
  party_name       TEXT,
  event_date       DATE NOT NULL,
  tax_code         TEXT NOT NULL,
  net_cents        BIGINT NOT NULL,
  tax_cents        BIGINT NOT NULL,
  prior_period     BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT fk_bas_return_events_return FOREIGN KEY (org_id, bas_return_id)
    REFERENCES bas_returns (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bas_return_events_return ON bas_return_events (org_id, bas_return_id);

CREATE TABLE IF NOT EXISTS bas_return_adjustments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bas_return_id  UUID NOT NULL,
  label          TEXT NOT NULL CHECK (label IN ('G7', 'G18')),
  gross_cents    BIGINT NOT NULL CHECK (gross_cents <> 0),
  tax_cents      BIGINT NOT NULL,
  -- The other side of the adjustment's GST, so the GST accounts stay reconciled.
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  reason         TEXT NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  created_by     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_bas_return_adjustments_return FOREIGN KEY (org_id, bas_return_id)
    REFERENCES bas_returns (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bas_return_adjustments_return ON bas_return_adjustments (org_id, bas_return_id);
CREATE INDEX IF NOT EXISTS idx_bas_return_adjustments_account ON bas_return_adjustments (account_id);
CREATE INDEX IF NOT EXISTS idx_bas_return_adjustments_created_by ON bas_return_adjustments (created_by);

-- A lodged return is a filed tax document (rule 6).
CREATE OR REPLACE FUNCTION bas_return_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'LODGED' THEN
    RAISE EXCEPTION 'a lodged BAS is immutable; correct it on a later return' USING ERRCODE = '0A000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_bas_returns_immutable
  BEFORE UPDATE OR DELETE ON bas_returns
  FOR EACH ROW EXECUTE FUNCTION bas_return_immutable();

-- A snapshot row never changes. It may be removed only by reopening a return
-- that is not lodged, or by that return being deleted.
CREATE OR REPLACE FUNCTION bas_return_child_guard() RETURNS trigger AS $$
DECLARE
  parent_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% rows are insert-only', TG_TABLE_NAME USING ERRCODE = '0A000';
  END IF;
  SELECT status INTO parent_status FROM bas_returns WHERE id = OLD.bas_return_id;
  IF parent_status = 'LODGED' THEN
    RAISE EXCEPTION 'a lodged BAS is immutable' USING ERRCODE = '0A000';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_bas_return_labels_guard
  BEFORE UPDATE OR DELETE ON bas_return_labels
  FOR EACH ROW EXECUTE FUNCTION bas_return_child_guard();
CREATE OR REPLACE TRIGGER trg_bas_return_events_guard
  BEFORE UPDATE OR DELETE ON bas_return_events
  FOR EACH ROW EXECUTE FUNCTION bas_return_child_guard();
CREATE OR REPLACE TRIGGER trg_bas_return_adjustments_guard
  BEFORE UPDATE OR DELETE ON bas_return_adjustments
  FOR EACH ROW EXECUTE FUNCTION bas_return_child_guard();

CREATE OR REPLACE TRIGGER trg_bas_returns_updated_at
  BEFORE UPDATE ON bas_returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_bas_returns_audit
  AFTER INSERT OR UPDATE OR DELETE ON bas_returns
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
CREATE OR REPLACE TRIGGER trg_bas_return_adjustments_audit
  AFTER INSERT OR UPDATE OR DELETE ON bas_return_adjustments
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
