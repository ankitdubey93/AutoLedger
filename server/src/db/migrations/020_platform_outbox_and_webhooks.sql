-- 020_platform_outbox_and_webhooks.sql
-- Phase 7 — the transactional outbox and financial-event webhooks. See
-- docs/roadmap.md's "Background jobs (Phase 7)" entry and
-- docs/ledger-core.md#webhooks-for-financial-events--phase-7.
--
-- Three tables: outbox_events (written inside the same transaction as the
-- financial fact it describes — see services/outboxService.ts), a per-org
-- webhook_endpoints subscription list, and webhook_deliveries (one row per
-- endpoint per event, tracking each attempt).

-- ------------------------------------------------------------- outbox_events

CREATE TABLE IF NOT EXISTS outbox_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_slug     TEXT NOT NULL CHECK (length(btrim(app_slug)) > 0 AND length(app_slug) <= 40),
  event_type   TEXT NOT NULL CHECK (length(btrim(event_type)) > 0 AND length(event_type) <= 60),
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

-- The drain query's ONLY index. Partial, because the interesting set is
-- always the unpublished tail — a full index would grow forever while the
-- query it serves never looks at a published row.
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
  ON outbox_events (id) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_org_created
  ON outbox_events (org_id, created_at DESC);

-- ---------------------------------------------------------- webhook_endpoints

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url         TEXT NOT NULL CHECK (length(btrim(url)) > 0 AND length(url) <= 500),
  label       TEXT NOT NULL CHECK (length(btrim(label)) > 0 AND length(label) <= 100),
  -- Stored in PLAINTEXT, unlike a password. Unlike a password hash, the
  -- server must reproduce this exact HMAC key on every send, so a one-way
  -- hash is not an option here. The mitigation is that this column is never
  -- selected into any API response (webhookService.ts's ENDPOINT_SELECT).
  secret      TEXT NOT NULL CHECK (length(secret) = 64),
  event_types TEXT[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 20),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_webhook_endpoints_org_id_id UNIQUE (org_id, id),
  CONSTRAINT ux_webhook_endpoints_org_url   UNIQUE (org_id, url)
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org_active
  ON webhook_endpoints (org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_created_by
  ON webhook_endpoints (created_by);

-- --------------------------------------------------------- webhook_deliveries

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_id      UUID NOT NULL,
  event_id         BIGINT NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL CHECK (length(event_type) <= 60),
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_status_code INTEGER CHECK (last_status_code IS NULL OR (last_status_code BETWEEN 100 AND 599)),
  last_error       TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_webhook_deliveries_org_id_id UNIQUE (org_id, id),
  -- Fan-out idempotency: draining the same event twice, or a retried drain
  -- pass, can never create a second delivery for the same endpoint.
  CONSTRAINT ux_webhook_deliveries_event_endpoint UNIQUE (event_id, endpoint_id),
  CONSTRAINT chk_webhook_delivery_delivered CHECK (
    (status =  'DELIVERED' AND delivered_at IS NOT NULL AND last_status_code IS NOT NULL) OR
    (status <> 'DELIVERED' AND delivered_at IS NULL)
  ),
  CONSTRAINT fk_webhook_delivery_endpoint
    FOREIGN KEY (org_id, endpoint_id) REFERENCES webhook_endpoints (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org_created
  ON webhook_deliveries (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org_status
  ON webhook_deliveries (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON webhook_deliveries (endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
  ON webhook_deliveries (event_id);
-- Serves the drain pass's stale-PENDING re-enqueue sweep.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON webhook_deliveries (updated_at) WHERE status = 'PENDING';

-- ------------------------------------------------------------------ triggers

CREATE OR REPLACE TRIGGER trg_webhook_endpoints_updated_at
  BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_webhook_deliveries_updated_at
  BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Audited: an endpoint is a configuration surface. Adding a URL is how a
-- tenant's financial events start leaving the building, so who added it and
-- when is a compliance question.
CREATE OR REPLACE TRIGGER trg_webhook_endpoints_audit
  AFTER INSERT OR UPDATE OR DELETE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');

-- outbox_events and webhook_deliveries are deliberately NOT audited. They
-- are high-volume transient machinery — one outbox row per financial
-- document and one delivery row per endpoint per event, each updated on
-- every attempt — and auditing them would multiply audit_logs several times
-- over with no compliance value the audited source row does not already
-- carry. Same reasoning migration 019 applies to bank_match_suggestions and
-- 018 applies to schema_migrations.
