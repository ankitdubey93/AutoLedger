-- 069_platform_organization_profile.sql
-- Phase 30 — the organization's postal identity: address, contact details,
-- legal name, industry and a logo. Platform-level (no app tag): company
-- identity, not bookkeeping configuration, and StockLedger's industry profiles
-- are a second consumer of `industry`.
--
-- One row per organization, keyed by org_id itself (same shape as
-- ledger_settings): org_id-as-PK indexes the scope column for free. The
-- ABSENCE of a row means "never filled in", not 404 — the service returns
-- defaults with configured: false.
--
-- contact_email is stored lowercase (guardrails rule 9); the CHECK
-- (contact_email = lower(contact_email)) rejects a mixed-case write that
-- bypasses the service.
--
-- The logo FK is COMPOSITE (org_id, logo_document_id) -> documents (org_id, id)
-- so one tenant's profile cannot point at another tenant's document
-- (guardrails rule 1); it targets ux_documents_org_id_id from migration 030.
-- ON DELETE RESTRICT, not SET NULL: a composite SET NULL would null org_id,
-- which is this table's primary key. With logo_document_id NULL the default
-- MATCH SIMPLE semantics skip the check, so "no logo" is valid.
--
-- ledger_settings.legal_name and ledger_settings.industry are SUPERSEDED by
-- this table. They stay on disk, unedited, per rule 13 (dropping a column
-- needs explicit sign-off); nothing reads or writes them after Phase 30.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING, so
-- migrations.test.ts can replay it against a populated database.

CREATE TABLE IF NOT EXISTS organization_profiles (
  org_id                UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  legal_name            TEXT CHECK (legal_name IS NULL OR (length(btrim(legal_name)) > 0 AND length(legal_name) <= 200)),
  industry              TEXT CHECK (industry IS NULL OR length(industry) <= 120),

  street_address_1      TEXT CHECK (street_address_1 IS NULL OR length(street_address_1) <= 200),
  street_address_2      TEXT CHECK (street_address_2 IS NULL OR length(street_address_2) <= 200),
  city                  TEXT CHECK (city IS NULL OR length(city) <= 120),
  region                TEXT CHECK (region IS NULL OR length(region) <= 120),
  postal_code           TEXT CHECK (postal_code IS NULL OR length(postal_code) <= 32),
  country_code          CHAR(2) CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),

  postal_same_as_street BOOLEAN NOT NULL DEFAULT true,
  postal_address_1      TEXT CHECK (postal_address_1 IS NULL OR length(postal_address_1) <= 200),
  postal_address_2      TEXT CHECK (postal_address_2 IS NULL OR length(postal_address_2) <= 200),
  postal_city           TEXT CHECK (postal_city IS NULL OR length(postal_city) <= 120),
  postal_region         TEXT CHECK (postal_region IS NULL OR length(postal_region) <= 120),
  postal_postal_code    TEXT CHECK (postal_postal_code IS NULL OR length(postal_postal_code) <= 32),
  postal_country_code   CHAR(2) CHECK (postal_country_code IS NULL OR postal_country_code ~ '^[A-Z]{2}$'),

  phone                 TEXT CHECK (phone IS NULL OR length(phone) <= 40),
  contact_email         TEXT CHECK (contact_email IS NULL OR (length(contact_email) <= 254 AND contact_email = lower(contact_email))),
  website               TEXT CHECK (website IS NULL OR length(website) <= 200),

  logo_document_id      UUID,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_organization_profiles_logo_document
    FOREIGN KEY (org_id, logo_document_id) REFERENCES documents (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_organization_profiles_logo_document
  ON organization_profiles (logo_document_id);

CREATE OR REPLACE TRIGGER trg_organization_profiles_updated_at
  BEFORE UPDATE ON organization_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One-time, idempotent backfill: legal_name and industry move here from
-- ledger_settings, whose columns stay on disk unwritten from Phase 30 Step 5.
INSERT INTO organization_profiles (org_id, legal_name, industry)
SELECT s.org_id, s.legal_name, s.industry
  FROM ledger_settings s
 WHERE s.legal_name IS NOT NULL OR s.industry IS NOT NULL
ON CONFLICT (org_id) DO NOTHING;
