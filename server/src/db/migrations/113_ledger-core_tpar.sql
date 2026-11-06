-- Phase 49h — the taxable payments annual report, for businesses in building,
-- cleaning, courier and road freight, IT, and security services.
--
-- Flagged per vendor, because that is who gets reported. A vendor who also sells
-- plain materials is a known limit: their bills all count, for a person to review.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tpar_reportable BOOLEAN NOT NULL DEFAULT false;

-- What was lodged for a financial year, kept as it stood.
CREATE TABLE IF NOT EXISTS tpar_returns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The year the financial year ends: 2026 is 1 July 2025 to 30 June 2026.
  financial_year  SMALLINT NOT NULL CHECK (financial_year BETWEEN 2000 AND 2100),
  lodged_on       DATE NOT NULL,
  ato_reference   TEXT CHECK (ato_reference IS NULL OR length(ato_reference) <= 100),
  rows            JSONB NOT NULL,
  lodged_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_tpar_returns_org_year UNIQUE (org_id, financial_year)
);
CREATE INDEX IF NOT EXISTS idx_tpar_returns_lodged_by ON tpar_returns (lodged_by);

CREATE OR REPLACE TRIGGER trg_tpar_returns_audit
  AFTER INSERT OR UPDATE OR DELETE ON tpar_returns
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
