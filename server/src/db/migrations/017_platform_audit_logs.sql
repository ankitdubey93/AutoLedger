-- 017_platform_audit_logs.sql
-- Phase 5 — the shared CDC audit trail. See docs/roadmap.md's "Audit trail &
-- CDC (Phase 5)" entry and docs/ledger-core.md's "Audit trail & internal
-- controls" showcase section.
--
-- This file creates the table and the two trigger functions that operate on
-- it. It attaches no triggers to any audited table — that is 018, kept
-- separate so a future app's migration can add its own attachment file
-- without touching this one.
--
-- Two columns below carry no REFERENCES, the single deliberate exception to
-- guardrails rule 8 in this codebase:
--
--   * org_id must survive the deletion of the organization it names — an
--     audit row documenting an event is history, not a live relationship,
--     and an FK would either block the very DELETE it exists to record, or
--     (with ON DELETE CASCADE) destroy the trail exactly when it matters most.
--   * actor_user_id has the same problem for a departed user, and
--     row_id is polymorphic across 16 tables, so no single FK target exists
--     for it at all regardless.
--
-- All three are denormalised snapshot values, not relationships. Every write
-- to this table happens from a trigger, never from application code — no
-- service, controller, or script ever INSERTs into audit_logs directly.
CREATE TABLE IF NOT EXISTS audit_logs (
  -- A monotonic identity, not a UUID like every other table's primary key:
  -- this is a log, and a plain sequence orders rows written in the same
  -- instant and makes a gap in it visible. Nothing else in this schema needs
  -- that property.
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Groups every row written by one transaction — an invoice issuance writes
  -- to invoices, journal_entries and ledger_lines in a single COMMIT, and
  -- this is what lets a reader reassemble that as one event.
  txid          BIGINT NOT NULL DEFAULT (pg_current_xact_id()::text::bigint),

  org_id        UUID,
  app_slug      TEXT NOT NULL CHECK (length(btrim(app_slug)) > 0),
  table_name    TEXT NOT NULL,
  row_id        UUID,
  operation     TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),

  old_row       JSONB,
  new_row       JSONB,
  -- UPDATE only: the top-level keys whose value actually changed. NULL for
  -- INSERT and DELETE, where "everything" and "nothing" are the only
  -- possible answers and naming every key would be noise.
  changed_keys  TEXT[],

  actor_user_id UUID,
  -- TEXT, not INET: current_setting() always returns text, and a malformed
  -- value must not abort the write it is only trying to annotate. Truncated
  -- to 45 characters, long enough for any IPv6 literal.
  client_ip     TEXT CHECK (client_ip IS NULL OR length(client_ip) <= 45),

  -- Defaults to now(), which is transaction start time in PostgreSQL, not
  -- statement time — every row written by one transaction therefore shares
  -- this value, and txid is what actually orders and groups them.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_audit_logs_payload CHECK (
    (operation = 'INSERT' AND old_row IS NULL     AND new_row IS NOT NULL) OR
    (operation = 'UPDATE' AND old_row IS NOT NULL AND new_row IS NOT NULL) OR
    (operation = 'DELETE' AND old_row IS NOT NULL AND new_row IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created
  ON audit_logs (org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_table_row
  ON audit_logs (org_id, table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_actor
  ON audit_logs (org_id, actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_app
  ON audit_logs (org_id, app_slug);
CREATE INDEX IF NOT EXISTS idx_audit_logs_txid
  ON audit_logs (txid);

-- ------------------------------------------------------------------ capture

-- Attached (in 018) as an AFTER trigger on every audited table. AFTER, not
-- BEFORE like 016's period guard: this trigger records what actually
-- happened, so it must run after every BEFORE trigger and every CHECK
-- constraint has had its chance to reject the row — a row this function
-- sees is a row that was genuinely committed to the table.
--
-- The actor and client IP cannot reach a trigger through req — a trigger
-- function has no access to the request at all — so they arrive as
-- transaction-local session variables, set via db/transaction.ts's
-- applyAuditContext() with set_config(name, value, is_local := true) and
-- read back here with current_setting(key, true). The `true` (missing_ok)
-- means a write with no request context (registration, db:reset,
-- verify:integrity, a future queued job) yields an empty string rather than
-- raising, which NULLIF below turns into a NULL actor — correct, since
-- nobody performed that write through the API.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger AS $$
DECLARE
  v_old     JSONB;
  v_new     JSONB;
  v_subject JSONB;
  v_org     UUID;
  v_row     UUID;
  v_changed TEXT[];
  v_actor   TEXT;
  v_ip      TEXT;
BEGIN
  v_old := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_new := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  v_subject := COALESCE(v_new, v_old);

  -- organizations has no org_id column of its own — its own id IS the tenant.
  IF TG_TABLE_NAME = 'organizations' THEN
    v_org := NULLIF(v_subject ->> 'id', '')::uuid;
  ELSE
    v_org := NULLIF(v_subject ->> 'org_id', '')::uuid;
  END IF;

  v_row := NULLIF(v_subject ->> 'id', '')::uuid;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(n.key ORDER BY n.key)
      INTO v_changed
      FROM jsonb_each(v_new) AS n(key, value)
     WHERE n.value IS DISTINCT FROM v_old -> n.key;
  END IF;

  v_actor := NULLIF(current_setting('app.current_user_id', true), '');
  v_ip    := NULLIF(current_setting('app.client_ip', true), '');

  -- TG_ARGV[0] is the audited app's slug, supplied by each CREATE TRIGGER
  -- statement in 018. A trigger created without that argument yields NULL
  -- here, which the NOT NULL check above rejects immediately — a missing
  -- slug fails loudly at the first write, not silently in every row after.
  INSERT INTO audit_logs (org_id, app_slug, table_name, row_id, operation,
                          old_row, new_row, changed_keys, actor_user_id, client_ip)
  VALUES (v_org, TG_ARGV[0], TG_TABLE_NAME, v_row, TG_OP,
          v_old, v_new, v_changed, v_actor::uuid, left(v_ip, 45));

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------- immutability

-- Guardrails rule 6's discipline extended to the trail itself: the trail is
-- the thing every other immutability rule is enforced in service of, so it
-- gets the same treatment posted ledger rows already have (004). ERRCODE
-- 0A000 is feature_not_supported — updating or deleting an audit row is not
-- a feature this schema has. TRUNCATE does not fire row-level triggers, so
-- resetTables() between test cases still works.
CREATE OR REPLACE FUNCTION reject_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
