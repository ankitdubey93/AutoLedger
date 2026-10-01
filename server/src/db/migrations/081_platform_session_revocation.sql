-- 081_platform_session_revocation.sql
-- Phase 38a — revoking a session leaves a tombstone instead of deleting it.
-- See docs/roadmap.md#phase-38a-as-delivered.
--
-- Refresh-token reuse detection (Phase 1) reads "valid signature, no row" as
-- a replayed token and signs the user out of EVERY session. If revoking a
-- browser deleted its row, that browser's next refresh would look exactly
-- like a replay — and would sign out the very session that revoked it. A
-- revoked row is therefore kept, marked, and refused quietly on refresh.
--
-- Tombstones expire with the row's own `expires_at` (at most 7 days).

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;
