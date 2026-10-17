-- Phase 46d — sign-in history. Not in audit_logs: users and refresh_tokens
-- are deliberately unaudited (017/018), and a FAILED sign-in must survive
-- the login transaction's ROLLBACK, so it is written outside it.
-- user_id is NULL for an unknown email; email is stored lowercased (rule 9).
CREATE TABLE IF NOT EXISTS login_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      UUID NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) <= 320),
  outcome     TEXT NOT NULL CHECK (outcome IN
                ('SUCCESS','FAILED','LOGOUT','PASSWORD_CHANGED','PASSWORD_RESET','SESSION_REVOKED')),
  ip          TEXT NULL CHECK (ip IS NULL OR char_length(ip) <= 45),
  user_agent  TEXT NULL CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_org ON login_events (org_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_login_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'login_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

-- UPDATE only: DELETE must stay possible so ON DELETE CASCADE from users /
-- organizations works (a BEFORE DELETE trigger would block the cascade).
CREATE OR REPLACE TRIGGER trg_login_events_immutable
  BEFORE UPDATE ON login_events
  FOR EACH ROW EXECUTE FUNCTION reject_login_event_mutation();
