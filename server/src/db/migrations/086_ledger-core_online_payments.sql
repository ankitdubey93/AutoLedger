-- 086_ledger-core_online_payments.sql
-- Phase 39c — paying an emailed statement online, by card, through Stripe.
--
--   ledger_online_payment_settings  per org: whether the statement page offers
--                                   card payment, and the Asset account the
--                                   resulting receipts are deposited into (a
--                                   "Stripe clearing" account, typically).
--   online_payments                 one row per Stripe PaymentIntent created
--                                   from a statement link. Its status FSM is
--                                   ONLINE_PAYMENT_TRANSITIONS in
--                                   types/accounting.ts (rule 10). Once the
--                                   intent succeeds it is RECORDED as a normal
--                                   `payments` row (the GL effect goes through
--                                   paymentService — this table posts nothing).
--   online_payment_invoices         what the customer chose to pay, and how
--                                   much of each — amounts the SERVER computed
--                                   from what was outstanding, never the client.
--
-- No card data is stored anywhere: card details go from the browser straight
-- to Stripe. `provider_intent_id` is unique, which is what makes settling an
-- intent idempotent between the webhook and the browser's confirm call.
-- Money is BIGINT cents (rule 3). Idempotent throughout.

CREATE TABLE IF NOT EXISTS ledger_online_payment_settings (
  org_id              UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  deposit_account_id  UUID NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Composite, so an org can never deposit into another tenant's account.
  -- RESTRICT: accounts are retired, never deleted (and a composite SET NULL
  -- would null org_id, this table's primary key).
  CONSTRAINT fk_online_payment_settings_deposit_account
    FOREIGN KEY (org_id, deposit_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT ck_online_payment_settings_enabled_account
    CHECK (NOT enabled OR deposit_account_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_online_payment_settings_deposit_account
  ON ledger_online_payment_settings (deposit_account_id);

CREATE OR REPLACE TRIGGER trg_ledger_online_payment_settings_updated_at
  BEFORE UPDATE ON ledger_online_payment_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_ledger_online_payment_settings_audit
  AFTER INSERT OR UPDATE OR DELETE ON ledger_online_payment_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE TABLE IF NOT EXISTS online_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  statement_send_id   UUID NOT NULL,
  customer_id         UUID NOT NULL,
  provider            TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe')),
  provider_intent_id  TEXT NULL,
  currency_code       TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'RECORDED', 'NEEDS_REVIEW', 'FAILED', 'CANCELED')),
  payment_id          UUID NULL,
  failure_reason      TEXT NULL CHECK (failure_reason IS NULL OR length(failure_reason) <= 500),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_online_payments_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_online_payments_provider_intent UNIQUE (provider, provider_intent_id),
  CONSTRAINT ck_online_payments_recorded
    CHECK ((status = 'RECORDED') = (payment_id IS NOT NULL)),
  CONSTRAINT fk_online_payments_send
    FOREIGN KEY (org_id, statement_send_id) REFERENCES statement_sends (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_online_payments_customer
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_online_payments_payment
    FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_online_payments_org_status ON online_payments (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_online_payments_send ON online_payments (org_id, statement_send_id);
CREATE INDEX IF NOT EXISTS idx_online_payments_customer ON online_payments (org_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_online_payments_payment ON online_payments (org_id, payment_id);

CREATE OR REPLACE TRIGGER trg_online_payments_updated_at
  BEFORE UPDATE ON online_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_online_payments_audit
  AFTER INSERT OR UPDATE OR DELETE ON online_payments
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');

CREATE TABLE IF NOT EXISTS online_payment_invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  online_payment_id  UUID NOT NULL,
  invoice_id         UUID NOT NULL,
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  CONSTRAINT ux_online_payment_invoices_pair UNIQUE (online_payment_id, invoice_id),
  CONSTRAINT fk_online_payment_invoices_payment
    FOREIGN KEY (org_id, online_payment_id) REFERENCES online_payments (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_online_payment_invoices_invoice
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_online_payment_invoices_invoice ON online_payment_invoices (org_id, invoice_id);
