import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import {
  BUILTIN_ROLE_PERMISSIONS,
  isPermission,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  withRequiredPermissions,
  type PermissionDefinition,
} from '../config/permissions.js';
import { BUILTIN_ROLES } from '../types/auth.js';
import { isSubset, resolveMemberAccess, type MemberAccess } from './permissionService.js';

/**
 * Phase 38c — an organization's custom roles. Scoped by `org_id` from the
 * verified token (rule 1); the composite foreign keys in migration 083 make
 * a role of another organization unassignable even if a service forgot.
 */

type Queryable = Pick<PoolClient, 'query'>;

/** Postgres unique-violation. */
const PG_UNIQUE_VIOLATION = '23505';

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  memberCount: number;
}

export interface RolesOverview {
  builtin: Array<{ role: (typeof BUILTIN_ROLES)[number]; permissions: string[] }>;
  custom: CustomRole[];
  catalogue: readonly PermissionDefinition[];
}

async function selectCustomRoles(q: Queryable, orgId: string, id: string | null): Promise<CustomRole[]> {
  const { rows } = await q.query<{
    id: string;
    name: string;
    description: string | null;
    permissions: string[];
    member_count: number;
  }>(
    `SELECT r.id, r.name, r.description,
            COALESCE((SELECT array_agg(p.permission ORDER BY p.permission)
                        FROM org_role_permissions p WHERE p.org_id = r.org_id AND p.role_id = r.id), '{}') AS permissions,
            (SELECT COUNT(*)::int FROM organization_members m WHERE m.org_id = r.org_id AND m.custom_role_id = r.id) AS member_count
       FROM org_roles r
      WHERE r.org_id = $1 AND ($2::uuid IS NULL OR r.id = $2::uuid)
      ORDER BY LOWER(r.name)`,
    [orgId, id],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: r.permissions.filter(isPermission),
    memberCount: r.member_count,
  }));
}

/** GET /organizations/roles — the built-in presets, this organization's custom roles, and the catalogue. */
export async function listRoles(orgId: string): Promise<RolesOverview> {
  return {
    builtin: BUILTIN_ROLES.map((role) => ({ role, permissions: [...BUILTIN_ROLE_PERMISSIONS[role]].sort() })),
    custom: await selectCustomRoles(pool, orgId, null),
    catalogue: PERMISSIONS,
  };
}

/**
 * Validates a requested permission list and returns what the role will
 * actually hold: known keys only, owner-tier keys refused, closed over
 * `requires`, and — for anyone but an OWNER — no key the editor lacks
 * (otherwise `roles.manage` would be a path to any permission at all).
 */
function resolveRequestedPermissions(actor: MemberAccess, requested: readonly string[]): string[] {
  const unknown = requested.filter((k) => !isPermission(k));
  if (unknown.length > 0) throw new ApiError(400, `Unknown permission: ${unknown.join(', ')}`);
  const ownerOnly = requested.filter((k) => OWNER_ONLY_PERMISSIONS.has(k));
  if (ownerOnly.length > 0) {
    throw new ApiError(422, `Only an owner can hold: ${ownerOnly.join(', ')} — it cannot be given to a custom role`);
  }
  const closed = withRequiredPermissions(requested);
  if (closed.size === 0) throw new ApiError(400, 'A role needs at least one permission');
  if (actor.role !== 'OWNER' && !isSubset(closed, actor.permissions)) {
    throw new ApiError(403, 'You cannot create a role with permissions you do not have yourself');
  }
  return [...closed].sort();
}

async function actorWithRolesManage(client: Queryable, orgId: string, actorId: string): Promise<MemberAccess> {
  const access = await resolveMemberAccess(client, orgId, actorId);
  if (access === null || !access.permissions.has('roles.manage')) {
    throw new ApiError(403, 'You need the "Create and edit custom roles" permission');
  }
  return access;
}

async function writePermissions(client: Queryable, orgId: string, roleId: string, keys: readonly string[]): Promise<void> {
  await client.query('DELETE FROM org_role_permissions WHERE org_id = $1 AND role_id = $2', [orgId, roleId]);
  await client.query(
    `INSERT INTO org_role_permissions (org_id, role_id, permission)
     SELECT $1, $2, unnest($3::text[])`,
    [orgId, roleId, keys],
  );
}

function mapNameConflict(err: unknown, name: string): never {
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === PG_UNIQUE_VIOLATION) {
    throw new ApiError(409, `A role called "${name}" already exists`);
  }
  throw err;
}

export interface RoleInput {
  name: string;
  description?: string | null | undefined;
  permissions: string[];
}

/** POST /organizations/roles */
export async function createRole(orgId: string, actor: { id: string }, input: RoleInput): Promise<CustomRole> {
  return withTransaction(async (client) => {
    const actorAccess = await actorWithRolesManage(client, orgId, actor.id);
    const keys = resolveRequestedPermissions(actorAccess, input.permissions);
    let id: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO org_roles (org_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [orgId, input.name, input.description ?? null, actor.id],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
      id = row.id;
    } catch (err) {
      mapNameConflict(err, input.name);
    }
    await writePermissions(client, orgId, id, keys);
    const [role] = await selectCustomRoles(client, orgId, id);
    if (role === undefined) throw new Error('created role not found');
    return role;
  });
}

/**
 * PATCH /organizations/roles/:id — replaces the name, description and
 * permission set. Takes effect for every member holding the role on their
 * next request (`requirePermission` re-reads per request).
 *
 * The organization row is locked first (as member changes do), so editing a
 * role and assigning it cannot interleave into an escalation.
 */
export async function updateRole(orgId: string, actor: { id: string }, roleId: string, input: RoleInput): Promise<CustomRole> {
  return withTransaction(async (client) => {
    await client.query('SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgId]);
    const actorAccess = await actorWithRolesManage(client, orgId, actor.id);
    const [existing] = await selectCustomRoles(client, orgId, roleId);
    if (existing === undefined) throw new ApiError(404, 'Role not found');
    // Editing a role is also an act on everyone who holds it: a non-owner may
    // not edit a role that is already beyond their own permissions.
    if (actorAccess.role !== 'OWNER' && !isSubset(new Set(existing.permissions), actorAccess.permissions)) {
      throw new ApiError(403, 'You cannot edit a role with permissions you do not have yourself');
    }
    const keys = resolveRequestedPermissions(actorAccess, input.permissions);
    try {
      await client.query('UPDATE org_roles SET name = $3, description = $4 WHERE org_id = $1 AND id = $2', [
        orgId,
        roleId,
        input.name,
        input.description ?? null,
      ]);
    } catch (err) {
      mapNameConflict(err, input.name);
    }
    await writePermissions(client, orgId, roleId, keys);
    const [role] = await selectCustomRoles(client, orgId, roleId);
    if (role === undefined) throw new ApiError(404, 'Role not found');
    return role;
  });
}

/** DELETE /organizations/roles/:id — refused while any member holds it. */
export async function deleteRole(orgId: string, actor: { id: string }, roleId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgId]);
    const actorAccess = await actorWithRolesManage(client, orgId, actor.id);
    const [existing] = await selectCustomRoles(client, orgId, roleId);
    if (existing === undefined) throw new ApiError(404, 'Role not found');
    if (actorAccess.role !== 'OWNER' && !isSubset(new Set(existing.permissions), actorAccess.permissions)) {
      throw new ApiError(403, 'You cannot delete a role with permissions you do not have yourself');
    }
    if (existing.memberCount > 0) {
      throw new ApiError(
        409,
        `${String(existing.memberCount)} member${existing.memberCount === 1 ? '' : 's'} still hold this role — give them another role first`,
      );
    }
    await client.query('DELETE FROM org_roles WHERE org_id = $1 AND id = $2', [orgId, roleId]);
  });
}
