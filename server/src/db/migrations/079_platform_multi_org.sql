-- 079_platform_multi_org.sql
-- Phase 37 — several organizations per user, and invitations into one.
-- See docs/roadmap.md#phase-37-as-delivered and docs/architecture.md.
--
-- Additive only. The many-to-many `organization_members` table has existed
-- since 001; what was missing was a way to create a second membership.

-- ----------------------------------------------------- users.last_active_org_id

-- The organization a login opens in. Written by every session issue (login,
-- refresh, switch, create, accept), read only by login. SET NULL, not
-- CASCADE: deleting an organization must never delete a user, and a NULL
-- falls back to the oldest membership — the pre-Phase-37 behaviour.
--
-- Not a tenancy check (rule 1): login re-validates the membership before
-- using it, so a stale value pointing at an org the user has left is ignored.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_active_org_id UUID NULL REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_last_active_org_id ON users (last_active_org_id);

-- --------------------------------------------------- organization_invitations

-- An invitation for an email address to join one organization with one role.
--
-- Delivery is a copyable link (there is no mail transport), so the token is a
-- bearer credential: only its SHA-256 is stored, exactly as refresh and
-- password-reset tokens are. Accepting also requires the signed-in account's
-- email to match `email` — the link alone is not enough.
--
-- Status is derived, never stored: accepted_at / revoked_at / expires_at
-- (types/organization.ts holds the transition table, rule 10).
--
-- Deliberately NOT audited (no audit_row_change trigger), for the same reason
-- 018 leaves refresh_tokens out: the trail would copy token_hash, a
-- credential, into an append-only table. The membership an acceptance
-- creates IS audited, through organization_members' own trigger.
CREATE TABLE IF NOT EXISTS organization_invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Lowercased on write (rule 9).
  email       TEXT NOT NULL CHECK (email = LOWER(email) AND email <> ''),
  role        TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER')),
  token_hash  TEXT NOT NULL,
  invited_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  accepted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  revoked_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_organization_invitations_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_organization_invitations_expires_after_created CHECK (expires_at > created_at),
  -- A terminal state is exactly one of the two.
  CONSTRAINT ck_organization_invitations_single_outcome CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT ck_organization_invitations_accepted_by CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);

-- Rule 8: the scope column, and the two user FKs.
CREATE INDEX IF NOT EXISTS idx_organization_invitations_org_id ON organization_invitations (org_id);
CREATE INDEX IF NOT EXISTS idx_organization_invitations_invited_by ON organization_invitations (invited_by);
CREATE INDEX IF NOT EXISTS idx_organization_invitations_accepted_by ON organization_invitations (accepted_by);

-- At most one open invitation per address per organization. "Open" includes
-- expired-but-unrevoked rows: re-inviting revokes the stale one first, in the
-- same transaction, so the index never blocks a legitimate re-invite.
CREATE UNIQUE INDEX IF NOT EXISTS ux_organization_invitations_open_email
  ON organization_invitations (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
