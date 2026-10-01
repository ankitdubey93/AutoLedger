-- 080_platform_session_metadata.sql
-- Phase 38a — "Sessions" in user settings: list your signed-in devices,
-- revoke one, sign out everywhere else. See docs/roadmap.md#phase-38a-as-delivered.
--
-- Additive only. A refresh row is replaced on every rotation (~15 minutes),
-- so its own `id` cannot name a session. `session_id` is minted at login and
-- carried forward by every rotation, switch-org, create-org, accept and
-- leave, so one browser stays one session in the list.

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS session_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What the browser said it was, truncated by the server. Display only —
  -- a client can claim any user agent, so nothing decides access by it.
  ADD COLUMN IF NOT EXISTS user_agent TEXT NULL CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  -- The socket peer address, as the audit trail records it (no X-Forwarded-For).
  ADD COLUMN IF NOT EXISTS ip TEXT NULL CHECK (ip IS NULL OR length(ip) <= 45);

-- At most one live row per session: rotation deletes the old row before it
-- inserts the new one, inside one transaction.
CREATE UNIQUE INDEX IF NOT EXISTS ux_refresh_tokens_session_id ON refresh_tokens (session_id);
