import type { PoolClient } from 'pg';
import {
  BUILTIN_ROLE_PERMISSIONS,
  isPermission,
  OWNER_ONLY_PERMISSIONS,
  type BuiltinRole,
  type Permission,
} from '../config/permissions.js';
import { isRole, type Role } from '../types/auth.js';

/**
 * Phase 38c — what a member may do in an organization, resolved from the
 * database **now**, not from the access token.
 *
 * Before 38c a route compared the role carried in the JWT, which can be up
 * to 15 minutes stale. With customisable roles, staleness becomes a
 * correctness problem — an owner who removes "void invoices" from a role
 * expects it to stop working, not to keep working until tokens expire — so
 * `requirePermission` calls this once per request: one join on the
 * membership's primary key plus the role's permission rows.
 *
 * Scoped by `org_id` from the verified token (rule 1).
 */

type Queryable = Pick<PoolClient, 'query'>;

export interface MemberAccess {
  role: Role;
  customRoleId: string | null;
  /** The built-in role, or the custom role's name. */
  roleName: string;
  permissions: ReadonlySet<Permission>;
}

/** Built-in roles map to their code-defined presets; a custom role to its stored keys. */
function permissionsFor(role: Role, stored: readonly string[]): ReadonlySet<Permission> {
  if (role !== 'CUSTOM') return BUILTIN_ROLE_PERMISSIONS[role as BuiltinRole];
  // Unknown keys (from an older catalogue) are ignored, and owner-tier keys
  // can never come from a custom role even if a row says so.
  return new Set(stored.filter((k): k is Permission => isPermission(k) && !OWNER_ONLY_PERMISSIONS.has(k)));
}

export async function resolveMemberAccess(q: Queryable, orgId: string, userId: string): Promise<MemberAccess | null> {
  const { rows } = await q.query<{
    role: string;
    custom_role_id: string | null;
    custom_role_name: string | null;
    permissions: string[];
  }>(
    `SELECT m.role, m.custom_role_id, r.name AS custom_role_name,
            COALESCE(array_agg(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
       FROM organization_members m
       LEFT JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.custom_role_id
       LEFT JOIN org_role_permissions p ON p.org_id = m.org_id AND p.role_id = m.custom_role_id
      WHERE m.org_id = $1 AND m.user_id = $2
      GROUP BY m.role, m.custom_role_id, r.name`,
    [orgId, userId],
  );
  const row = rows[0];
  if (row === undefined || !isRole(row.role)) return null;
  return {
    role: row.role,
    customRoleId: row.custom_role_id,
    roleName: row.role === 'CUSTOM' ? (row.custom_role_name ?? 'Custom role') : row.role,
    permissions: permissionsFor(row.role, row.permissions),
  };
}

/** The permission set a role (built-in or custom) would grant — for escalation checks. */
export async function permissionsOfRole(
  q: Queryable,
  orgId: string,
  target: { role: Role; customRoleId: string | null },
): Promise<ReadonlySet<Permission> | null> {
  if (target.role !== 'CUSTOM') return BUILTIN_ROLE_PERMISSIONS[target.role as BuiltinRole];
  if (target.customRoleId === null) return null;
  const { rows: roleRows } = await q.query('SELECT 1 FROM org_roles WHERE org_id = $1 AND id = $2', [
    orgId,
    target.customRoleId,
  ]);
  if (roleRows.length === 0) return null;
  const { rows } = await q.query<{ permission: string }>(
    'SELECT permission FROM org_role_permissions WHERE org_id = $1 AND role_id = $2',
    [orgId, target.customRoleId],
  );
  return permissionsFor('CUSTOM', rows.map((r) => r.permission));
}

/** True when every key of `subset` is in `superset`. */
export function isSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const key of subset) if (!superset.has(key)) return false;
  return true;
}
