-- 089_ledger-core_quotes.sql
-- Phase 41 — quotes, sales and purchase, in one table.
--
--   quotes           A priced commercial offer. direction = 'SALES' (to a
--                    customer, converts to an invoice) or 'PURCHASE' (to or
--                    from a vendor, converts to a bill). A quote NEVER posts:
--                    no journal entry, no stock movement, no frozen FX rate —
--                    under IFRS 15 / ASC 606 a contract exists only once the
--                    offer is accepted, and revenue/expense is recognised
--                    later, on the invoice or bill it becomes.
--                    Immutable once SENT (trigger below); a change is a new
--                    revision of the same number (root_quote_id chain), which
--                    supersedes the sent one when it is itself sent.
--   quote_lines      Priced lines, editable only while the quote is DRAFT.
--   quote_links      The public "Review and accept" link — token stored ONLY
--                    as its SHA-256 hash, exactly like statement_sends (085).
--   quote_responses  The acceptance/decline evidence: insert-only, one per
--                    quote ever (the UNIQUE is the race arbiter between two
--                    simultaneous responses), carrying the signer's typed
--                    name, IP, user agent and the hash of the exact content
--                    they saw.
--   invoices/bills   gain source_quote_id: which quote a document was
--                    converted from. A partial UNIQUE makes conversion
--                    once-only, including after the document is voided.
--
-- The status CHECK must match QUOTE_STATUSES, and the trigger's transition
-- list must match QUOTE_TRANSITIONS, in server/src/types/accounting.ts
-- (guardrails rule 10) — quoteConstraints.test.ts walks every pair.
--
-- Idempotent throughout; the migration test replays every file.

-- ------------------------------------------------- numbering and defaults

ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS quote_prefix               TEXT     NOT NULL DEFAULT 'QU-' CHECK (length(quote_prefix) <= 12);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS quote_next_number          INTEGER  NOT NULL DEFAULT 1     CHECK (quote_next_number > 0);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS purchase_quote_prefix      TEXT     NOT NULL DEFAULT 'PQ-' CHECK (length(purchase_quote_prefix) <= 12);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS purchase_quote_next_number INTEGER  NOT NULL DEFAULT 1     CHECK (purchase_quote_next_number > 0);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS default_quote_validity_days SMALLINT NOT NULL DEFAULT 30   CHECK (default_quote_validity_days BETWEEN 1 AND 365);
ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS default_quote_terms        TEXT     NULL CHECK (default_quote_terms IS NULL OR length(default_quote_terms) <= 5000);

-- --------------------------------------------------------------------- quotes

CREATE TABLE IF NOT EXISTS quotes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, matching invoices: an organization's commercial history is kept.
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  direction             TEXT NOT NULL CHECK (direction IN ('SALES', 'PURCHASE')),
  customer_id           UUID NULL,
  vendor_id             UUID NULL,

  -- Revision chain. The first version is its own root (the service sets
  -- root_quote_id = id); revision n+1 supersedes revision n.
  root_quote_id         UUID NOT NULL,
  supersedes_quote_id   UUID NULL,
  revision              SMALLINT NOT NULL DEFAULT 1 CHECK (revision >= 1),

  -- NULL while DRAFT — allocated at the first send, so a deleted draft never
  -- burns a number. A revision inherits its predecessor's number.
  quote_number          TEXT NULL,
  status                TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                          'DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'VOID', 'SUPERSEDED', 'CONVERTED')),
  quote_date            DATE NOT NULL,
  valid_until           DATE NOT NULL,
  currency_code         CHAR(3) NOT NULL,

  -- Snapshotted on every draft save and again at send, so a sent quote never
  -- changes when the customer/vendor record is later edited.
  party_name_snapshot        TEXT NOT NULL,
  party_address_snapshot     TEXT NULL,
  party_tax_number_snapshot  TEXT NULL,
  party_email_snapshot       TEXT NULL,

  -- The customer's RFQ/PO number, or the vendor's own quote number.
  party_reference       TEXT NULL CHECK (party_reference IS NULL OR length(party_reference) <= 100),
  title                 TEXT NULL CHECK (title IS NULL OR length(title) <= 200),
  notes                 TEXT NULL CHECK (notes IS NULL OR length(notes) <= 1000),
  -- The terms the signer accepts.
  terms                 TEXT NULL CHECK (terms IS NULL OR length(terms) <= 5000),
  payment_terms         TEXT NULL,
  payment_terms_code    TEXT NULL,

  subtotal_cents        BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents             BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents           BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),

  -- Indicative only: the rate on the quote date when one existed. The
  -- invoice/bill resolves and freezes its own rate for its own date.
  indicative_fx_rate          NUMERIC(18,8) NULL CHECK (indicative_fx_rate IS NULL OR indicative_fx_rate > 0),
  indicative_base_total_cents BIGINT NULL,

  -- SHA-256 of the canonical frozen content, set at send. An acceptance must
  -- quote it back, so a signer can only ever accept exactly what they saw.
  content_sha256        TEXT NULL CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),

  sent_at               TIMESTAMPTZ NULL,
  sent_by               UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at           TIMESTAMPTZ NULL,
  declined_at           TIMESTAMPTZ NULL,
  expired_at            TIMESTAMPTZ NULL,
  voided_at             TIMESTAMPTZ NULL,
  void_reason           TEXT NULL CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  superseded_at         TIMESTAMPTZ NULL,
  converted_at          TIMESTAMPTZ NULL,
  converted_by          UUID NULL REFERENCES users(id) ON DELETE RESTRICT,

  created_by            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_quotes_org_id_id UNIQUE (org_id, id),
  -- Target of the invoices/bills back-link FK: carrying the direction in the
  -- key is what stops a sales quote ever becoming a bill.
  CONSTRAINT ux_quotes_org_id_id_direction UNIQUE (org_id, id, direction),
  -- Direction is in the key because the two prefixes may be set to the same text.
  CONSTRAINT ux_quotes_number UNIQUE (org_id, direction, quote_number, revision),
  -- A quote is revised at most once; the chain is linear.
  CONSTRAINT ux_quotes_supersedes UNIQUE (org_id, supersedes_quote_id),
  CONSTRAINT ck_quotes_party CHECK (
    (direction = 'SALES'    AND customer_id IS NOT NULL AND vendor_id IS NULL) OR
    (direction = 'PURCHASE' AND vendor_id   IS NOT NULL AND customer_id IS NULL)
  ),
  CONSTRAINT ck_quotes_revision CHECK ((revision = 1) = (supersedes_quote_id IS NULL)),
  CONSTRAINT ck_quotes_validity CHECK (valid_until >= quote_date),
  CONSTRAINT chk_quotes_total CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT ck_quotes_indicative_fx CHECK ((indicative_fx_rate IS NULL) = (indicative_base_total_cents IS NULL)),
  CONSTRAINT ck_quotes_sent_complete CHECK (
    status = 'DRAFT' OR (quote_number IS NOT NULL AND sent_at IS NOT NULL AND content_sha256 IS NOT NULL)
  ),
  CONSTRAINT ck_quotes_accepted_complete   CHECK (status NOT IN ('ACCEPTED', 'CONVERTED') OR accepted_at IS NOT NULL),
  CONSTRAINT ck_quotes_declined_complete   CHECK (status <> 'DECLINED'   OR declined_at IS NOT NULL),
  CONSTRAINT ck_quotes_expired_complete    CHECK (status <> 'EXPIRED'    OR expired_at IS NOT NULL),
  CONSTRAINT ck_quotes_void_complete       CHECK (status <> 'VOID'       OR (voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CONSTRAINT ck_quotes_superseded_complete CHECK (status <> 'SUPERSEDED' OR superseded_at IS NOT NULL),
  CONSTRAINT ck_quotes_converted_complete  CHECK (status <> 'CONVERTED'  OR (converted_at IS NOT NULL AND converted_by IS NOT NULL)),

  -- Composite FKs keep every reference inside the tenant (rule 8). Customers
  -- and vendors are never deleted (retired with is_active), hence RESTRICT.
  CONSTRAINT fk_quotes_customer
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_quotes_vendor
    FOREIGN KEY (org_id, vendor_id) REFERENCES vendors (org_id, id) ON DELETE RESTRICT,
  -- DEFERRABLE: a first version references itself as root, inserted in one statement.
  CONSTRAINT fk_quotes_root
    FOREIGN KEY (org_id, root_quote_id) REFERENCES quotes (org_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_quotes_supersedes
    FOREIGN KEY (org_id, supersedes_quote_id) REFERENCES quotes (org_id, id) ON DELETE RESTRICT
);

-- One open draft and one live sent version per chain.
CREATE UNIQUE INDEX IF NOT EXISTS ux_quotes_one_draft_per_root
  ON quotes (org_id, root_quote_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX IF NOT EXISTS ux_quotes_one_sent_per_root
  ON quotes (org_id, root_quote_id) WHERE status = 'SENT';

CREATE INDEX IF NOT EXISTS idx_quotes_org_direction_status_date ON quotes (org_id, direction, status, quote_date DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_customer     ON quotes (org_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_vendor       ON quotes (org_id, vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_root         ON quotes (org_id, root_quote_id);
CREATE INDEX IF NOT EXISTS idx_quotes_created_by   ON quotes (created_by);
CREATE INDEX IF NOT EXISTS idx_quotes_sent_by      ON quotes (sent_by);
CREATE INDEX IF NOT EXISTS idx_quotes_converted_by ON quotes (converted_by);
-- The expiry sweep's scan.
CREATE INDEX IF NOT EXISTS idx_quotes_sent_valid_until ON quotes (valid_until) WHERE status = 'SENT';

-- ---------------------------------------------------------------- quote_lines

CREATE TABLE IF NOT EXISTS quote_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  quote_id           UUID NOT NULL,

  line_number        SMALLINT NOT NULL CHECK (line_number > 0),
  description        TEXT NOT NULL CHECK (length(btrim(description)) > 0 AND length(description) <= 500),
  -- Thousandths of a unit, cents, basis points — the invoice_lines units (009).
  quantity_milli     BIGINT NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 1000000000),
  unit_price_cents   BIGINT NOT NULL CHECK (unit_price_cents >= 0 AND unit_price_cents <= 1000000000000),
  -- Revenue for a sales quote, Expense/Asset for a purchase quote — checked
  -- in the service (a CHECK cannot see the account's type).
  account_id         UUID NOT NULL,
  tax_rate_bp        INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  net_cents          BIGINT NOT NULL CHECK (net_cents >= 0),
  tax_cents          BIGINT NOT NULL CHECK (tax_cents >= 0),
  item_id            UUID NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_quote_lines_quote_line UNIQUE (quote_id, line_number),
  CONSTRAINT fk_quote_lines_quote
    FOREIGN KEY (org_id, quote_id) REFERENCES quotes (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_quote_lines_account
    FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_quote_lines_item
    FOREIGN KEY (org_id, item_id) REFERENCES items (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_quote_lines_quote   ON quote_lines (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_lines_account ON quote_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_quote_lines_item    ON quote_lines (item_id) WHERE item_id IS NOT NULL;

-- ---------------------------------------------------------------- quote_links

CREATE TABLE IF NOT EXISTS quote_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  quote_id        UUID NOT NULL,
  to_email        TEXT NOT NULL CHECK (to_email = LOWER(to_email) AND length(to_email) BETWEEN 3 AND 254),
  sent_by         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ NULL,
  last_viewed_at  TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_quote_links_token_hash UNIQUE (token_hash),
  CONSTRAINT ux_quote_links_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ck_quote_links_expiry CHECK (expires_at > created_at),
  CONSTRAINT fk_quote_links_quote
    FOREIGN KEY (org_id, quote_id) REFERENCES quotes (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quote_links_quote   ON quote_links (org_id, quote_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quote_links_sent_by ON quote_links (sent_by);

-- Not audited: the row carries the token hash, and audit_logs would copy it
-- (the reasoning that leaves statement_sends unaudited in 085).

-- ------------------------------------------------------------ quote_responses

CREATE TABLE IF NOT EXISTS quote_responses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  quote_id              UUID NOT NULL,
  link_id               UUID NULL,
  response              TEXT NOT NULL CHECK (response IN ('ACCEPTED', 'DECLINED')),
  -- PUBLIC_LINK: the recipient answered on the emailed page. INTERNAL: staff
  -- recorded an answer received another way (a signed PDF, a phone call).
  channel               TEXT NOT NULL CHECK (channel IN ('PUBLIC_LINK', 'INTERNAL')),
  signer_name           TEXT NULL CHECK (signer_name IS NULL OR length(signer_name) <= 200),
  signer_email          TEXT NULL CHECK (signer_email IS NULL OR (signer_email = LOWER(signer_email) AND length(signer_email) <= 254)),
  terms_accepted        BOOLEAN NOT NULL DEFAULT false,
  decline_reason        TEXT NULL CHECK (decline_reason IS NULL OR length(decline_reason) <= 1000),
  client_ip             TEXT NULL CHECK (client_ip IS NULL OR length(client_ip) <= 45),
  user_agent            TEXT NULL CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  recorded_by           UUID NULL REFERENCES users(id) ON DELETE RESTRICT,
  note                  TEXT NULL CHECK (note IS NULL OR length(note) <= 1000),
  quote_content_sha256  TEXT NOT NULL CHECK (quote_content_sha256 ~ '^[0-9a-f]{64}$'),
  responded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One response per quote, ever: the database decides a race between an
  -- accept and a decline (or two accepts), not the application.
  CONSTRAINT ux_quote_responses_quote UNIQUE (org_id, quote_id),
  CONSTRAINT ck_quote_responses_accept CHECK (
    response <> 'ACCEPTED' OR (signer_name IS NOT NULL AND length(btrim(signer_name)) > 0 AND terms_accepted)
  ),
  CONSTRAINT ck_quote_responses_channel CHECK (
    (channel = 'PUBLIC_LINK' AND link_id IS NOT NULL AND recorded_by IS NULL) OR
    (channel = 'INTERNAL'    AND link_id IS NULL     AND recorded_by IS NOT NULL)
  ),
  CONSTRAINT fk_quote_responses_quote
    FOREIGN KEY (org_id, quote_id) REFERENCES quotes (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_quote_responses_link
    FOREIGN KEY (org_id, link_id) REFERENCES quote_links (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_quote_responses_link        ON quote_responses (link_id) WHERE link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quote_responses_recorded_by ON quote_responses (recorded_by);

-- Evidence is insert-only (reject_mutation from 004).
CREATE OR REPLACE TRIGGER trg_quote_responses_immutable
  BEFORE UPDATE OR DELETE ON quote_responses
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE OR REPLACE TRIGGER trg_quote_responses_audit
  AFTER INSERT OR UPDATE OR DELETE ON quote_responses
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

-- ------------------------------------------------- invoice / bill back-links

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_quote_id        UUID NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_quote_direction TEXT NULL;
ALTER TABLE bills    ADD COLUMN IF NOT EXISTS source_quote_id        UUID NULL;
ALTER TABLE bills    ADD COLUMN IF NOT EXISTS source_quote_direction TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_invoices_source_quote') THEN
    ALTER TABLE invoices ADD CONSTRAINT ck_invoices_source_quote CHECK (
      (source_quote_id IS NULL AND source_quote_direction IS NULL) OR
      (source_quote_id IS NOT NULL AND source_quote_direction = 'SALES')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_source_quote') THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_source_quote
      FOREIGN KEY (org_id, source_quote_id, source_quote_direction)
      REFERENCES quotes (org_id, id, direction) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_bills_source_quote') THEN
    ALTER TABLE bills ADD CONSTRAINT ck_bills_source_quote CHECK (
      (source_quote_id IS NULL AND source_quote_direction IS NULL) OR
      (source_quote_id IS NOT NULL AND source_quote_direction = 'PURCHASE')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bills_source_quote') THEN
    ALTER TABLE bills ADD CONSTRAINT fk_bills_source_quote
      FOREIGN KEY (org_id, source_quote_id, source_quote_direction)
      REFERENCES quotes (org_id, id, direction) ON DELETE RESTRICT;
  END IF;
END $$;

-- Convert once: a quote can be the source of at most one invoice/bill, even
-- after that document is voided (voiding never frees the quote).
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_source_quote
  ON invoices (org_id, source_quote_id) WHERE source_quote_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_bills_source_quote
  ON bills (org_id, source_quote_id) WHERE source_quote_id IS NOT NULL;

-- ------------------------------------------------------------------- triggers

-- Immutability once a quote leaves DRAFT, enforced by the database and not
-- only by the service. A DRAFT changes freely (and is the only status that
-- may be deleted). Any other UPDATE must be one of QUOTE_TRANSITIONS and may
-- touch only the status and its own timestamp columns — never the number,
-- party, lines' totals, terms or content hash a signer saw.
CREATE OR REPLACE FUNCTION reject_sent_quote_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Quote % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = '0A000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    -- A draft's content changes freely; its only status exit is SENT.
    IF NEW.status NOT IN ('DRAFT', 'SENT') THEN
      RAISE EXCEPTION 'Quote % is DRAFT and cannot become %', OLD.id, NEW.status
        USING ERRCODE = '0A000';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'SENT'      AND NEW.status IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'VOID', 'SUPERSEDED'))
    OR (OLD.status = 'ACCEPTED'  AND NEW.status IN ('CONVERTED', 'VOID'))
    OR (OLD.status = 'CONVERTED' AND NEW.status = 'ACCEPTED')
  ) THEN
    RAISE EXCEPTION 'Quote % is % and cannot become %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = '0A000';
  END IF;

  IF to_jsonb(NEW) - ARRAY['status', 'updated_at', 'accepted_at', 'declined_at', 'expired_at', 'voided_at',
                           'void_reason', 'superseded_at', 'converted_at', 'converted_by']
     IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['status', 'updated_at', 'accepted_at', 'declined_at', 'expired_at', 'voided_at',
                           'void_reason', 'superseded_at', 'converted_at', 'converted_by'] THEN
    RAISE EXCEPTION 'Quote % is % — only its status may change', OLD.id, OLD.status
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_quotes_immutable
  BEFORE UPDATE OR DELETE ON quotes
  FOR EACH ROW EXECUTE FUNCTION reject_sent_quote_mutation();

-- A line may only be inserted, changed, or removed while its quote is DRAFT.
-- NULL status means the parent is already gone (the CASCADE of a deleted
-- draft, which the trigger above authorised).
CREATE OR REPLACE FUNCTION reject_non_draft_quote_line_mutation() RETURNS trigger AS $$
DECLARE
  v_quote_id UUID;
  v_status   TEXT;
BEGIN
  v_quote_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END;
  SELECT status INTO v_status FROM quotes WHERE id = v_quote_id;

  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Quote % is % — its lines cannot be changed', v_quote_id, v_status
      USING ERRCODE = '0A000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_quote_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION reject_non_draft_quote_line_mutation();

-- Named to sort after trg_quotes_immutable (same reasoning as 009); the
-- guard excludes updated_at anyway.
CREATE OR REPLACE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_quotes_audit
  AFTER INSERT OR UPDATE OR DELETE ON quotes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

-- -------------------------------------------------- email and notifications

ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS ck_email_outbox_template;
ALTER TABLE email_outbox ADD CONSTRAINT ck_email_outbox_template CHECK (template IN (
  'password_reset', 'invitation', 'verify_email', 'confirm_email_change',
  'email_changed_notice', 'bill_awaiting_approval', 'invitation_accepted',
  'party_statement', 'quote_sent', 'quote_responded'));

-- The original CHECK was declared inline in 082 and carries Postgres'
-- generated name; it is replaced by a named one.
ALTER TABLE user_notification_preferences DROP CONSTRAINT IF EXISTS user_notification_preferences_event_check;
ALTER TABLE user_notification_preferences DROP CONSTRAINT IF EXISTS ck_user_notification_preferences_event;
ALTER TABLE user_notification_preferences ADD CONSTRAINT ck_user_notification_preferences_event CHECK (event IN (
  'bill_awaiting_approval', 'invitation_accepted', 'quote_responded'));
