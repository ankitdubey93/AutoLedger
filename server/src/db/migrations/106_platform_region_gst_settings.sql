-- Phase 49a — the Australian edition's foundation.
--
-- `organizations.region` selects a jurisdiction pack. It is deliberately not
-- organization_profiles.country_code: that is where a business's letters go,
-- and a postal address must never switch on a tax engine.
--
-- gst_settings holds a row only for an AU organization, so a GENERIC one has
-- nothing new to read. Its own table rather than ledger_settings because an
-- organization that skips the setup wizard has no ledger_settings row.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'GENERIC';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_organizations_region') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT chk_organizations_region CHECK (region IN ('GENERIC', 'AU'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gst_settings (
  org_id       UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  registered   BOOLEAN NOT NULL DEFAULT true,
  basis        TEXT NOT NULL DEFAULT 'CASH' CHECK (basis IN ('CASH', 'ACCRUAL')),
  bas_cycle    TEXT NOT NULL DEFAULT 'QUARTERLY' CHECK (bas_cycle IN ('QUARTERLY', 'MONTHLY')),
  bas_method   TEXT NOT NULL DEFAULT 'SIMPLER' CHECK (bas_method IN ('SIMPLER', 'FULL')),
  -- Here as well as ledger_settings.timezone: that row only exists once the
  -- wizard is finished, and "today" must be right before then too.
  time_zone    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_gst_settings_updated_at
  BEFORE UPDATE ON gst_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_gst_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON gst_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
