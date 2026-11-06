-- 105_ledger-core_invoice_delivery.sql
-- Phase 48: get invoices out and get paid.
--   * email_outbox.attachment_kind / attachment_ref_id  (a reference, not bytes;
--     the PDF is rendered at drain time) and the template list gains
--     'invoice_sent', 'invoice_reminder'
--   * invoice_sends      one row per emailed invoice link (token hash only).
--                        Sent/viewed state is derived from here: an issued
--                        invoice is immutable, so it cannot carry columns for it.
--   * invoice_reminders  exactly-once guard, one row per (invoice, offset)
--   * online_payments    may now come from an invoice link instead of a statement
--   * ledger_invoice_settings  reminder settings
--   * recurring_schedules.auto_send
-- Idempotent throughout: every constraint is dropped-and-re-added or guarded.

-- ---------------------------------------------------------------------------
-- email_outbox
-- ---------------------------------------------------------------------------
ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS attachment_kind TEXT NULL,
  ADD COLUMN IF NOT EXISTS attachment_ref_id UUID NULL;

ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS ck_email_outbox_attachment;
ALTER TABLE email_outbox ADD CONSTRAINT ck_email_outbox_attachment CHECK (
  (attachment_kind IS NULL AND attachment_ref_id IS NULL)
  OR (attachment_kind IN ('INVOICE_PDF') AND attachment_ref_id IS NOT NULL AND org_id IS NOT NULL));

ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS ck_email_outbox_template;
ALTER TABLE email_outbox ADD CONSTRAINT ck_email_outbox_template CHECK (template IN (
  'password_reset', 'invitation', 'verify_email', 'confirm_email_change',
  'email_changed_notice', 'bill_awaiting_approval', 'invitation_accepted',
  'party_statement', 'quote_sent', 'quote_responded', 'quote_acceptance_code',
  'invoice_sent', 'invoice_reminder'));

-- ---------------------------------------------------------------------------
-- invoice_sends
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_sends (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id     UUID NOT NULL,
  send_kind      TEXT NOT NULL CHECK (send_kind IN ('MANUAL', 'REMINDER', 'RECURRING')),
  to_email       TEXT NOT NULL CHECK (to_email = LOWER(to_email) AND length(to_email) BETWEEN 3 AND 254),
  email_id       UUID NULL REFERENCES email_outbox(id) ON DELETE SET NULL,
  sent_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash     TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ NULL,
  last_viewed_at TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_invoice_sends_token_hash UNIQUE (token_hash),
  CONSTRAINT ux_invoice_sends_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ck_invoice_sends_expiry CHECK (expires_at > created_at),
  CONSTRAINT fk_invoice_sends_invoice FOREIGN KEY (org_id, invoice_id)
    REFERENCES invoices (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_invoice_sends_org_invoice ON invoice_sends (org_id, invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_sends_email ON invoice_sends (email_id);
CREATE INDEX IF NOT EXISTS idx_invoice_sends_sent_by ON invoice_sends (sent_by);

-- Not audited: the row carries the token hash (same reasoning as statement_sends).

-- ---------------------------------------------------------------------------
-- invoice_reminders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_reminders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id      UUID NOT NULL,
  offset_days     INTEGER NOT NULL CHECK (offset_days BETWEEN -60 AND 365),
  invoice_send_id UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_invoice_reminders_offset UNIQUE (org_id, invoice_id, offset_days),
  CONSTRAINT fk_invoice_reminders_invoice FOREIGN KEY (org_id, invoice_id)
    REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_reminders_send FOREIGN KEY (org_id, invoice_send_id)
    REFERENCES invoice_sends (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_invoice_reminders_send ON invoice_reminders (org_id, invoice_send_id);

-- ---------------------------------------------------------------------------
-- online_payments: statement link OR invoice link, exactly one
-- ---------------------------------------------------------------------------
ALTER TABLE online_payments ALTER COLUMN statement_send_id DROP NOT NULL;
ALTER TABLE online_payments ADD COLUMN IF NOT EXISTS invoice_send_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_online_payments_invoice_send') THEN
    ALTER TABLE online_payments
      ADD CONSTRAINT fk_online_payments_invoice_send
      FOREIGN KEY (org_id, invoice_send_id) REFERENCES invoice_sends (org_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_online_payments_source') THEN
    ALTER TABLE online_payments
      ADD CONSTRAINT ck_online_payments_source
      CHECK ((statement_send_id IS NULL) <> (invoice_send_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_online_payments_invoice_send ON online_payments (org_id, invoice_send_id);

-- ---------------------------------------------------------------------------
-- reminder settings
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_invoice_settings
  ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_offsets_days INTEGER[] NOT NULL DEFAULT '{7,14,30}';

-- ---------------------------------------------------------------------------
-- recurring auto-send
-- ---------------------------------------------------------------------------
ALTER TABLE recurring_schedules
  ADD COLUMN IF NOT EXISTS auto_send BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_recurring_auto_send') THEN
    ALTER TABLE recurring_schedules
      ADD CONSTRAINT ck_recurring_auto_send
      CHECK (NOT auto_send OR (kind = 'INVOICE' AND mode = 'POST'));
  END IF;
END $$;
