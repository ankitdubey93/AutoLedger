-- 077_platform_password_reset_tokens.sql
-- Pre-showcase polish (2026-09-29), Batch 5 — forgot / reset password.
-- See docs/roadmap.md#pre-showcase-polish-2026-09-29.
--
-- Org-less, like `users` and `refresh_tokens`: a password belongs to an
-- identity, not to any one organization, so there is no tenant to scope by
-- (the stated reason rule 1's org-less exceptions require).
--
-- A token is consumed with `DELETE ... RETURNING` — the same atomic claim
-- `refresh_tokens` uses — so a row's existence *is* "not yet used" and there
-- is no used_at column to keep in step.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the emailed token, never the token itself: a database dump
  -- must not yield a usable reset link. A fast hash is correct for a 256-bit
  -- random value; bcrypt exists to slow down guessing low-entropy passwords.
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_password_reset_tokens_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_password_reset_tokens_expires_after_created CHECK (expires_at > created_at)
);

-- Rule 8. Issuing a new token deletes the user's earlier ones, and a
-- successful reset deletes all of them — both filter by user_id.
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens (user_id);

-- Sweeping expired rows without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens (expires_at);
