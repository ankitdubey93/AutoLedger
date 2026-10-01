-- 083_platform_custom_roles.sql
-- Phase 38c — custom roles over a per-area permission catalogue. See
-- docs/roadmap.md#phase-38c-as-delivered and server/src/config/permissions.ts.
--
-- The four built-in roles stay what they were; their permission sets live
-- in code (config/permissions.ts), so they cannot drift per organization.
-- A member now holds either a built-in role or the new 'CUSTOM' role plus a
-- pointer to one of their organization's custom roles.

-- ---------------------------------------------------------------- org_roles

CREATE TABLE IF NOT EXISTS org_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  description TEXT NULL CHECK (description IS NULL OR length(description) <= 300),
  created_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The target of the composite foreign keys below: a member or invitation
  -- can only point at a role of its OWN organization, enforced by the
  -- database, not just the service (docs/schema.md § composite FKs).
  CONSTRAINT ux_org_roles_org_id_id UNIQUE (org_id, id)
);

-- One "Invoice clerk" per organization, case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS ux_org_roles_org_name ON org_roles (org_id, LOWER(name));
CREATE INDEX IF NOT EXISTS idx_org_roles_created_by ON org_roles (created_by);

CREATE OR REPLACE TRIGGER trg_org_roles_updated_at BEFORE UPDATE ON org_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_org_roles_audit AFTER INSERT OR UPDATE OR DELETE ON org_roles
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');

-- ----------------------------------------------------- org_role_permissions

-- One row per (role, permission key). Keys are validated against the
-- catalogue in code rather than a CHECK: the catalogue grows with the
-- product, and a CHECK would need a migration for every new key. A key the
-- code no longer knows is ignored on read.
CREATE TABLE IF NOT EXISTS org_role_permissions (
  org_id     UUID NOT NULL,
  role_id    UUID NOT NULL,
  permission TEXT NOT NULL CHECK (permission ~ '^[a-z_]+\.[a-z_]+$'),
  PRIMARY KEY (role_id, permission),
  CONSTRAINT fk_org_role_permissions_role FOREIGN KEY (org_id, role_id)
    REFERENCES org_roles (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_org_role_permissions_org_role ON org_role_permissions (org_id, role_id);

CREATE OR REPLACE TRIGGER trg_org_role_permissions_audit AFTER INSERT OR UPDATE OR DELETE ON org_role_permissions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');

-- ------------------------------------------------------ organization_members

-- Re-state the role CHECK to admit 'CUSTOM' (the technique 078 used for
-- import kinds: drop and re-add under the same name, idempotently).
ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS organization_members_role_check;
ALTER TABLE organization_members
  ADD CONSTRAINT organization_members_role_check CHECK (role IN ('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER', 'CUSTOM'));

ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS custom_role_id UUID NULL;

ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS fk_organization_members_custom_role;
-- RESTRICT: a role in use cannot be deleted (the service answers 409 first).
ALTER TABLE organization_members
  ADD CONSTRAINT fk_organization_members_custom_role FOREIGN KEY (org_id, custom_role_id)
    REFERENCES org_roles (org_id, id) ON DELETE RESTRICT;

ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS ck_organization_members_custom_role;
ALTER TABLE organization_members
  ADD CONSTRAINT ck_organization_members_custom_role CHECK ((role = 'CUSTOM') = (custom_role_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_organization_members_custom_role ON organization_members (org_id, custom_role_id)
  WHERE custom_role_id IS NOT NULL;

-- -------------------------------------------------- organization_invitations

ALTER TABLE organization_invitations DROP CONSTRAINT IF EXISTS organization_invitations_role_check;
ALTER TABLE organization_invitations
  ADD CONSTRAINT organization_invitations_role_check CHECK (role IN ('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER', 'CUSTOM'));

ALTER TABLE organization_invitations ADD COLUMN IF NOT EXISTS custom_role_id UUID NULL;

ALTER TABLE organization_invitations DROP CONSTRAINT IF EXISTS fk_organization_invitations_custom_role;
-- CASCADE: deleting a role takes its still-open invitations with it (the
-- service refuses to delete a role in use by members; an unaccepted
-- invitation is not "in use").
ALTER TABLE organization_invitations
  ADD CONSTRAINT fk_organization_invitations_custom_role FOREIGN KEY (org_id, custom_role_id)
    REFERENCES org_roles (org_id, id) ON DELETE CASCADE;

ALTER TABLE organization_invitations DROP CONSTRAINT IF EXISTS ck_organization_invitations_custom_role;
ALTER TABLE organization_invitations
  ADD CONSTRAINT ck_organization_invitations_custom_role CHECK ((role = 'CUSTOM') = (custom_role_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_organization_invitations_custom_role ON organization_invitations (org_id, custom_role_id)
  WHERE custom_role_id IS NOT NULL;
