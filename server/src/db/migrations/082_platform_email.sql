-- 082_platform_email.sql
-- Phase 38b — real email: a transactional outbox, verification and
-- change-of-email tokens, an organization's sender settings, and each
-- user's notification preferences. See docs/roadmap.md#phase-38b-as-delivered.
--
-- Additive and idempotent.

-- ------------------------------------------------------------ email_outbox

-- Every email the product sends is first a row here, written on the SAME
-- transaction as the change that caused it (rule 5: no post-COMMIT work).
-- A worker drain (`email-drain`, every few seconds) claims due rows with
-- FOR UPDATE SKIP LOCKED and hands them to the transport outside any
-- transaction. Delivery is at-least-once: a crash between the provider
-- accepting a message and the row being marked SENT re-sends it.
--
-- `org_id` is nullable: password reset and email verification belong to an
-- identity, not an organization. The drain is a platform process that reads
-- every organization's rows, as `outbox-drain` does for webhooks.
--
-- `secret_link` is the one value that must never sit here long: the
-- token-bearing link (reset, invitation, verification). It is AES-256-GCM
-- encrypted when INTEGRATION_ENCRYPTION_KEY is set (required in production
-- for any real transport — config/env.ts) and set to NULL as soon as the
-- message is SENT or FAILED.
--
-- Not audited: the trail would copy the link. Status lives in
-- EMAIL_STATUS_TRANSITIONS (types/email.ts, rule 10).
CREATE TABLE IF NOT EXISTS email_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NULL REFERENCES organizations(id) ON DELETE CASCADE,
  to_email            TEXT NOT NULL CHECK (to_email = LOWER(to_email) AND to_email <> ''),
  to_name             TEXT NULL,
  template            TEXT NOT NULL CHECK (template IN (
                        'password_reset', 'invitation', 'verify_email', 'confirm_email_change',
                        'email_changed_notice', 'bill_awaiting_approval', 'invitation_accepted')),
  template_data       JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(template_data) = 'object'),
  secret_link         TEXT NULL,
  secret_encrypted    BOOLEAN NOT NULL DEFAULT false,
  sender_name         TEXT NULL CHECK (sender_name IS NULL OR length(sender_name) <= 100),
  reply_to            TEXT NULL CHECK (reply_to IS NULL OR reply_to = LOWER(reply_to)),
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at          TIMESTAMPTZ NULL,
  last_error          TEXT NULL CHECK (last_error IS NULL OR length(last_error) <= 500),
  provider_message_id TEXT NULL,
  sent_at             TIMESTAMPTZ NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_email_outbox_sent_at CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),
  -- A finished row carries no link.
  CONSTRAINT ck_email_outbox_link_cleared CHECK (status NOT IN ('SENT', 'FAILED') OR secret_link IS NULL)
);

-- Rule 8: the scope column.
CREATE INDEX IF NOT EXISTS idx_email_outbox_org_id ON email_outbox (org_id);
-- The drain's two scans: due PENDING rows, and SENDING rows a crashed
-- worker left behind.
CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_email_outbox_sending ON email_outbox (claimed_at) WHERE status = 'SENDING';

-- -------------------------------------------------------- user_email_tokens

-- Verification and change-of-email links. Hashed at rest (SHA-256), single
-- use (consumed with DELETE ... RETURNING), like password_reset_tokens. The
-- legacy plaintext `users.email_verification_*` columns from 001 stay
-- unused (rule 13 — never edit an applied migration).
CREATE TABLE IF NOT EXISTS user_email_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('VERIFY', 'CHANGE')),
  -- The address being verified, or the address being changed TO. Stored
  -- for VERIFY too, so a token minted for an address the user has since
  -- changed away from cannot verify the new one.
  email      TEXT NOT NULL CHECK (email = LOWER(email) AND email <> ''),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_user_email_tokens_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_user_email_tokens_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_user_email_tokens_user_id ON user_email_tokens (user_id);

-- ------------------------------------------------ organization_email_settings

-- How email sent on an organization's behalf presents itself. The From
-- ADDRESS is always the platform's verified sender (MAIL_FROM_EMAIL) — a
-- free Brevo account only sends from verified senders — so an organization
-- chooses the display name and where replies go.
CREATE TABLE IF NOT EXISTS organization_email_settings (
  org_id      UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  sender_name TEXT NULL CHECK (sender_name IS NULL OR (length(sender_name) BETWEEN 1 AND 100)),
  reply_to    TEXT NULL CHECK (reply_to IS NULL OR (reply_to = LOWER(reply_to) AND reply_to <> '')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER trg_organization_email_settings_updated_at BEFORE UPDATE ON organization_email_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_organization_email_settings_audit AFTER INSERT OR UPDATE OR DELETE ON organization_email_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');

-- ------------------------------------------- user_notification_preferences

-- Opt-outs per user and event. No row means the default (enabled), so a new
-- event reaches everyone without a backfill. Per user, not per organization:
-- "don't email me about bills" is a preference about the person's inbox.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      TEXT NOT NULL CHECK (event IN ('bill_awaiting_approval', 'invitation_accepted')),
  enabled    BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event)
);
