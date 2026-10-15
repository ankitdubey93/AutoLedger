-- 091_ledger-core_quote_signer_verification.sql
-- Phase 42 slice D: verified-email acceptance of a quote.
--   * ledger_invoice_settings.quote_acceptance_requires_code  (org opt-in)
--   * quote_responses.signer_email_verified                   (evidence)
--   * quote_acceptance_codes                                  (6-digit codes, hash only)
--   * email_outbox template list gains 'quote_acceptance_code'

ALTER TABLE ledger_invoice_settings
  ADD COLUMN IF NOT EXISTS quote_acceptance_requires_code BOOLEAN NOT NULL DEFAULT false;

-- quote_responses is insert-only (reject_mutation() row trigger from 089).
-- ADD COLUMN ... DEFAULT is DDL, not an UPDATE, so that row trigger does not
-- fire; existing evidence rows read as signer_email_verified = false.
ALTER TABLE quote_responses
  ADD COLUMN IF NOT EXISTS signer_email_verified BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_quote_responses_email_verified'
  ) THEN
    ALTER TABLE quote_responses
      ADD CONSTRAINT ck_quote_responses_email_verified
      CHECK (NOT signer_email_verified OR signer_email IS NOT NULL);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS quote_acceptance_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  link_id       UUID NOT NULL,
  signer_email  TEXT NOT NULL CHECK (signer_email = LOWER(signer_email) AND length(signer_email) BETWEEN 3 AND 254),
  code_hash     TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at   TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_quote_acceptance_codes_expiry CHECK (expires_at > created_at),
  CONSTRAINT fk_quote_acceptance_codes_link
    FOREIGN KEY (org_id, link_id) REFERENCES quote_links (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quote_acceptance_codes_link
  ON quote_acceptance_codes (org_id, link_id, created_at DESC);

-- Not audited: the row carries a code hash and audit_logs would copy it
-- (same reasoning that leaves quote_links unaudited in 089).

ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS ck_email_outbox_template;
ALTER TABLE email_outbox ADD CONSTRAINT ck_email_outbox_template CHECK (template IN (
  'password_reset', 'invitation', 'verify_email', 'confirm_email_change',
  'email_changed_notice', 'bill_awaiting_approval', 'invitation_accepted',
  'party_statement', 'quote_sent', 'quote_responded', 'quote_acceptance_code'));
