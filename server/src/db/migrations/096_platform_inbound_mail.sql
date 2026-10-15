-- 096_platform_inbound_mail.sql
-- Phase 43d — an email-in address per organization for the bill inbox. A mail
-- provider (Brevo inbound parsing) POSTs a webhook per received email; the
-- attachments are fetched and captured exactly like a direct upload.
-- See docs/roadmap.md#phase-43-as-delivered.
--
-- Additive and idempotent.
--
-- inbound_mail_addresses: at most one ACTIVE address per (org, purpose)
-- (partial unique index). `token` is the local part of the address — 16
-- lowercase base32 characters from crypto.randomBytes — and is globally
-- unique because it is how an inbound message finds its organization (the one
-- lookup in the product that has no org_id predicate: the token IS the
-- discovery of the org). Rotating deactivates the row and inserts a new one;
-- a deactivated token never routes again.
CREATE TABLE IF NOT EXISTS inbound_mail_addresses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'VENDOR_BILL',
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ NULL,
  CONSTRAINT ck_inbound_mail_addresses_token CHECK (token ~ '^[a-z2-7]{16}$'),
  CONSTRAINT ck_inbound_mail_addresses_purpose CHECK (purpose IN ('VENDOR_BILL')),
  CONSTRAINT ux_inbound_mail_addresses_token UNIQUE (token),
  -- Target of the composite FK from inbound_messages (tenant-local).
  CONSTRAINT ux_inbound_mail_addresses_org_id_id UNIQUE (org_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_inbound_mail_addresses_org_active
  ON inbound_mail_addresses (org_id, purpose) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_inbound_mail_addresses_org_id ON inbound_mail_addresses (org_id);
CREATE INDEX IF NOT EXISTS idx_inbound_mail_addresses_created_by ON inbound_mail_addresses (created_by);

-- inbound_messages: one row per (org, provider, provider message id) — the
-- unique constraint is the idempotency key, so a provider retry of the same
-- webhook creates nothing new. No message body or attachment is stored here;
-- only metadata and an outcome.
CREATE TABLE IF NOT EXISTS inbound_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  address_id          UUID NOT NULL,
  provider            TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  from_address        TEXT NOT NULL,
  subject             TEXT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status              TEXT NOT NULL DEFAULT 'RECEIVED',
  attachment_count    INTEGER NOT NULL DEFAULT 0,
  imported_count      INTEGER NOT NULL DEFAULT 0,
  error               TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_inbound_messages_status CHECK (status IN ('RECEIVED', 'IMPORTED', 'PARTIAL', 'REJECTED', 'FAILED')),
  CONSTRAINT ck_inbound_messages_counts CHECK (attachment_count >= 0 AND imported_count >= 0),
  CONSTRAINT ck_inbound_messages_error_len CHECK (error IS NULL OR length(error) <= 500),
  -- Named constraint (not just an index) so the writer can use ON CONFLICT ON CONSTRAINT.
  CONSTRAINT ux_inbound_messages_provider_msg UNIQUE (org_id, provider, provider_message_id),
  CONSTRAINT fk_inbound_messages_address FOREIGN KEY (org_id, address_id)
    REFERENCES inbound_mail_addresses (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_org_received ON inbound_messages (org_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_address ON inbound_messages (address_id);
