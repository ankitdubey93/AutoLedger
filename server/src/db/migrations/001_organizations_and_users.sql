-- 001_organizations_and_users.sql
-- Phase 1 — identity and tenancy. See docs/schema.md and docs/architecture.md.
--
-- Every statement is idempotent (IF NOT EXISTS / CREATE OR REPLACE) so the
-- file can be replayed against a database that already has part of it. The
-- runner applies each file inside a single transaction, and PostgreSQL has
-- transactional DDL, so a failure anywhere below leaves the database
-- completely untouched.
--
-- `gen_random_uuid()` is built into PostgreSQL 13+ — the pgcrypto extension is
-- NOT required, and adding it would be a needless privilege escalation.

-- ---------------------------------------------------------------- trigger fn

-- One shared function for every table carrying updated_at (docs/schema.md).
-- CREATE OR REPLACE makes it inherently idempotent.
--
-- Distinct from the Phase 4 audit-log triggers, which capture OLD/NEW row
-- snapshots. Do not conflate the two.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------------- organizations

-- The tenant boundary. Every domain table from Phase 2 onward carries
-- org_id REFERENCES organizations(id).
CREATE TABLE IF NOT EXISTS organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  slug          TEXT UNIQUE NOT NULL,
  -- CHAR(3) alone would accept 'usd', '123' or '   '. The regex is what
  -- actually enforces an ISO-4217-shaped code.
  base_currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (base_currency ~ '^[A-Z]{3}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------- users

-- Global identity, deliberately WITHOUT org_id: a user may belong to several
-- organizations, so identity precedes membership (docs/architecture.md).
CREATE TABLE IF NOT EXISTS users (
  id                               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                             TEXT,
  email                            TEXT NOT NULL,
  -- bcrypt digest, never a plaintext or reversible value.
  password                         TEXT NOT NULL,
  -- Columns exist per docs/schema.md, but there is no mailer and no verify
  -- endpoint yet, so they stay NULL and login does NOT depend on them.
  -- Wired up in a later phase.
  email_verified                   BOOLEAN NOT NULL DEFAULT false,
  email_verification_token         TEXT,
  email_verification_token_expires TIMESTAMPTZ,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- guardrails.md rule 11. A plain UNIQUE(email) would let 'A@x.com' and
-- 'a@x.com' both register; the prior build's register/login case mismatch
-- locked users out of their own accounts. lower(text) is IMMUTABLE, which is
-- what makes it legal in an index expression.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_lower ON users (LOWER(email));

-- --------------------------------------------------------- organization_members

-- Membership + role. Permissions are per organization, not global.
CREATE TABLE IF NOT EXISTS organization_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Belt and braces with the isRole() guard in src/types/auth.ts. The four
  -- roles are fixed until a module genuinely needs a fifth
  -- (docs/architecture.md).
  role       TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

-- The UNIQUE(org_id, user_id) index already covers org_id-leading lookups.
-- This one covers the other direction: "which orgs does this user belong to",
-- which is every login and every /auth/check.
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON organization_members (user_id);

-- -------------------------------------------------------------- refresh_tokens

-- Org-less like `users` — a session belongs to an identity. The org_id column
-- is the *active org hint* for the session, not a tenant scope.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the token, never the token itself: a database dump must not
  -- yield usable credentials. A fast hash is correct here — the token is a
  -- 200+ bit random value, so bcrypt (built to slow down guessing of
  -- low-entropy human passwords) would buy nothing and cost a lot.
  token_hash TEXT NOT NULL UNIQUE,
  -- Which organization this session is currently scoped to, so a rotated
  -- access token lands in the same org. Nullable: a user with no memberships
  -- can still hold a session.
  org_id     UUID REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Required by rule 8 (index every FK used in a join). Both the family
-- invalidation on token reuse and logout filter by user_id.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens (user_id);

-- Supports sweeping expired rows without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);

-- ------------------------------------------------------------------- triggers

-- CREATE OR REPLACE TRIGGER requires PostgreSQL 14+; docker-compose pins 16.
-- BEFORE UPDATE, so the new value is written as part of the same row version
-- rather than costing a second write.
CREATE OR REPLACE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
