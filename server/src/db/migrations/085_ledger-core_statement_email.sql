-- 085_ledger-core_statement_email.sql
-- Phase 39b — emailing customer & vendor statements.
--
--   statement_email_templates  user-editable subject/body per party kind, with
--                              {{placeholders}} substituted from a closed
--                              whitelist in code (utils/placeholders.ts) — text
--                              only, never markup; the HTML part escapes every
--                              value. At most one default per (org, kind).
--   statement_sends            one row per statement emailed: what was sent, to
--                              whom, by whom, and the "Review and pay" link's
--                              token — stored ONLY as its SHA-256 hash, exactly
--                              like organization_invitations (079). The raw
--                              token travels once, encrypted, in email_outbox.
--   email_outbox.template      gains 'party_statement'. The original CHECK was
--                              declared inline in 082 and so carries Postgres'
--                              generated name; it is replaced by a named one.
--                              The IN list must match EMAIL_TEMPLATES in
--                              server/src/types/email.ts.
--
-- Idempotent throughout; the migration test replays every file.

CREATE TABLE IF NOT EXISTS statement_email_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_kind  TEXT NOT NULL CHECK (party_kind IN ('CUSTOMER', 'VENDOR')),
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 100),
  subject     TEXT NOT NULL CHECK (length(btrim(subject)) > 0 AND length(subject) <= 200),
  body        TEXT NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 5000),
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Target of statement_sends' composite FK, so a send can never reference
  -- another tenant's template.
  CONSTRAINT ux_statement_email_templates_org_id_id UNIQUE (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_statement_email_templates_org_kind
  ON statement_email_templates (org_id, party_kind);
CREATE INDEX IF NOT EXISTS idx_statement_email_templates_created_by
  ON statement_email_templates (created_by);
CREATE UNIQUE INDEX IF NOT EXISTS ux_statement_email_templates_default
  ON statement_email_templates (org_id, party_kind) WHERE is_default;

CREATE OR REPLACE TRIGGER trg_statement_email_templates_updated_at
  BEFORE UPDATE ON statement_email_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_statement_email_templates_audit
  AFTER INSERT OR UPDATE OR DELETE ON statement_email_templates
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE TABLE IF NOT EXISTS statement_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_kind      TEXT NOT NULL CHECK (party_kind IN ('CUSTOMER', 'VENDOR')),
  customer_id     UUID NULL,
  vendor_id       UUID NULL,
  statement_type  TEXT NOT NULL CHECK (statement_type IN ('OUTSTANDING', 'ACTIVITY')),
  as_of           DATE NULL,
  period_from     DATE NULL,
  period_to       DATE NULL,
  template_id     UUID NULL,
  to_email        TEXT NOT NULL CHECK (to_email = LOWER(to_email) AND length(to_email) BETWEEN 3 AND 254),
  sent_by         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ NULL,
  last_viewed_at  TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_statement_sends_token_hash UNIQUE (token_hash),
  CONSTRAINT ux_statement_sends_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ck_statement_sends_party CHECK (
    (party_kind = 'CUSTOMER' AND customer_id IS NOT NULL AND vendor_id IS NULL) OR
    (party_kind = 'VENDOR'   AND vendor_id   IS NOT NULL AND customer_id IS NULL)
  ),
  CONSTRAINT ck_statement_sends_dates CHECK (
    (statement_type = 'OUTSTANDING' AND as_of IS NOT NULL AND period_from IS NULL AND period_to IS NULL) OR
    (statement_type = 'ACTIVITY' AND as_of IS NULL AND period_from IS NOT NULL AND period_to IS NOT NULL
       AND period_from <= period_to)
  ),
  CONSTRAINT ck_statement_sends_expiry CHECK (expires_at > created_at),
  -- Composite FKs keep every reference inside the tenant (rule 8). Customers
  -- and vendors are never deleted (retired with is_active), hence RESTRICT.
  CONSTRAINT fk_statement_sends_customer
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_statement_sends_vendor
    FOREIGN KEY (org_id, vendor_id) REFERENCES vendors (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_statement_sends_template
    FOREIGN KEY (org_id, template_id) REFERENCES statement_email_templates (org_id, id)
    ON DELETE SET NULL (template_id)
);

CREATE INDEX IF NOT EXISTS idx_statement_sends_org_customer
  ON statement_sends (org_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statement_sends_org_vendor
  ON statement_sends (org_id, vendor_id, created_at DESC) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_statement_sends_template ON statement_sends (org_id, template_id);
CREATE INDEX IF NOT EXISTS idx_statement_sends_sent_by ON statement_sends (sent_by);

-- Not audited: the row carries the token hash, and audit_logs would copy it
-- (the same reasoning that leaves email_outbox unaudited in 082).

ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_template_check;
ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS ck_email_outbox_template;
ALTER TABLE email_outbox ADD CONSTRAINT ck_email_outbox_template CHECK (template IN (
  'password_reset', 'invitation', 'verify_email', 'confirm_email_change',
  'email_changed_notice', 'bill_awaiting_approval', 'invitation_accepted',
  'party_statement'));
