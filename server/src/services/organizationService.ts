import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { slugify } from '../utils/validate.js';
import { seedDefaultChart } from './accounting/accountService.js';
import { seedStandardPaymentTerms } from './accounting/paymentTermService.js';
import { isRole, type OrganizationMember, type OrganizationSummary, type Role } from '../types/auth.js';
import { isSubset, permissionsOfRole, resolveMemberAccess, type MemberAccess } from './permissionService.js';

/**
 * Organization reads and updates, scoped to the caller's active organization.
 *
 * Every function takes `orgId` as its first argument (docs/architecture.md) and
 * every query carries an `org_id` predicate. That `orgId` always originates
 * from the verified access token — never a param, header or body.
 */

/** Both `pool` and a checked-out `PoolClient` satisfy this — see authService.ts. */
type Queryable = Pick<PoolClient, 'query'>;

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  base_currency: string;
  tax_number: string | null;
  business_number: string | null;
  created_at: Date;
}

function toOrganizationSummary(row: OrganizationRow): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    // CHAR(3) is blank-padded on read in some drivers; trim defensively.
    baseCurrency: row.base_currency.trim(),
    taxNumber: row.tax_number,
    businessNumber: row.business_number,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The active organization's own record.
 *
 * Scoped rather than a bare lookup by id: even though the id comes from a
 * signed token, keeping the predicate here means the query is still correct if
 * this is ever called from somewhere less trustworthy.
 */
export async function getById(orgId: string): Promise<OrganizationSummary> {
  const { rows } = await pool.query<OrganizationRow>(
    'SELECT id, name, slug, base_currency, tax_number, business_number, created_at FROM organizations WHERE id = $1',
    [orgId],
  );

  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Organization not found');
  return toOrganizationSummary(row);
}

/**
 * Edits the organization's name and/or base currency.
 *
 * Takes a `Queryable` last, defaulting to `pool`, so `settingsService`'s
 * onboarding transaction can pass its checked-out `client` and have this write
 * commit or roll back together with the rest of onboarding (guardrails rule
 * 5) — a stray `pool.query` here would run on a different connection and
 * commit immediately regardless of the caller's transaction.
 */
export async function updateOrganization(
  orgId: string,
  input: {
    name?: string | undefined;
    baseCurrency?: string | undefined;
    taxNumber?: string | null | undefined;
    businessNumber?: string | null | undefined;
  },
  q: Queryable = pool,
): Promise<OrganizationSummary> {
  // Column names come from this frozen map, never from the request — rule 4
  // forbids interpolating an identifier a caller could influence.
  const COLUMNS = {
    name: 'name',
    baseCurrency: 'base_currency',
    taxNumber: 'tax_number',
    businessNumber: 'business_number',
  } as const;

  const assignments: string[] = [];
  const values: unknown[] = [orgId];

  for (const key of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    const value = input[key];
    if (value === undefined) continue;
    values.push(value);
    assignments.push(`${COLUMNS[key]} = $${String(values.length)}`);
  }

  if (assignments.length === 0) throw new ApiError(400, 'No fields to update');

  const sql = `UPDATE organizations SET ${assignments.join(', ')}
      WHERE id = $1
      RETURNING id, name, slug, base_currency, tax_number, business_number, created_at`;

  // Phase 9a: the base-currency lock used to live only in
  // settingsService.completeOnboarding, leaving this route free to change a
  // base currency out from under an organization that already has ledger
  // lines. The guard and the write now share one transaction — a
  // check-then-act split across two round trips would race a concurrent
  // journal post.
  async function runUpdate(client: Queryable): Promise<{ rows: OrganizationRow[] }> {
    if (input.baseCurrency !== undefined) {
      const { rows: guardRows } = await client.query<{ base_currency: string; has_lines: boolean }>(
        `SELECT o.base_currency,
                EXISTS (SELECT 1 FROM ledger_lines l WHERE l.org_id = o.id) AS has_lines
           FROM organizations o
          WHERE o.id = $1`,
        [orgId],
      );
      const guard = guardRows[0];
      if (guard === undefined) throw new ApiError(404, 'Organization not found');
      if (guard.has_lines && guard.base_currency.trim() !== input.baseCurrency) {
        throw new ApiError(422, 'Base currency cannot be changed once journal entries exist');
      }
    }
    return client.query<OrganizationRow>(sql, values);
  }

  // `q === pool` means no caller has already opened a transaction, so this
  // write opens its own (Phase 5 — every write needs a transaction for the
  // audit context to attach to). A caller that passed its own `client`
  // (settingsService's onboarding transaction) already has one; wrapping it
  // again would try to BEGIN a transaction that is already open.
  const { rows } = q === pool ? await withTransaction(runUpdate) : await runUpdate(q);

  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Organization not found');
  return toOrganizationSummary(row);
}

/**
 * Everyone in one organization.
 *
 * The `WHERE m.org_id = $1` is the tenant boundary: without it this would
 * return every user in the database, which is precisely the leak guardrails
 * rule 1 exists to prevent. Covered by the cross-tenant isolation test — a
 * caller in org A must never see a member of org B, no matter what they put in
 * the query string, headers or body.
 */
export async function listMembers(orgId: string): Promise<OrganizationMember[]> {
  const { rows } = await pool.query<{
    user_id: string;
    name: string | null;
    email: string;
    role: string;
    custom_role_id: string | null;
    custom_role_name: string | null;
    joined_at: Date;
  }>(
    `SELECT u.id AS user_id, u.name, u.email, m.role, m.custom_role_id, r.name AS custom_role_name,
            m.created_at AS joined_at
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.custom_role_id
      WHERE m.org_id = $1
      ORDER BY m.created_at ASC`,
    [orgId],
  );

  return rows.map((r) => {
    if (!isRole(r.role)) throw new Error(`Unknown role "${r.role}" in org ${orgId}`);
    return {
      userId: r.user_id,
      name: r.name,
      email: r.email,
      role: r.role,
      customRoleId: r.custom_role_id,
      roleName: r.role === 'CUSTOM' ? (r.custom_role_name ?? 'Custom role') : r.role,
      joinedAt: r.joined_at.toISOString(),
    };
  });
}

/* ------------------------------------------- Phase 37 — create and members */

/**
 * Creates an organization owned by `userId`: the organization row (with a
 * unique slug), the OWNER membership, the default chart of accounts and the
 * standard payment terms. Shared by `authService.register` (a new user's
 * first organization) and `authService.createOrganization` (an existing
 * user's next one), so the two can never drift.
 *
 * Runs on the caller's `client` (rule 5): an organization without a chart
 * cannot post anything, so the seeds are part of creating one, and a stray
 * `pool.query` would commit a chart for an organization the caller's
 * rollback then erased.
 *
 * Accounting's onboarding details (fiscal year, base currency, cash account)
 * are not collected here — the setup wizard (`POST /settings/onboarding`)
 * does that, per organization, the first time someone opens it.
 */
export async function createOrganizationOnClient(client: Queryable, userId: string, name: string): Promise<string> {
  // Slug is globally unique and organization names collide constantly
  // ("Acme"). ON CONFLICT DO NOTHING is what makes retrying possible inside
  // a transaction: a caught 23505 would have poisoned the block, forcing a
  // SAVEPOINT round trip per attempt.
  const base = slugify(name);
  let orgId: string | undefined;

  for (let attempt = 0; attempt < 5 && orgId === undefined; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(16).slice(2, 8)}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [name, candidate],
    );
    orgId = rows[0]?.id;
  }

  if (orgId === undefined) {
    throw new ApiError(409, 'Could not allocate a unique organization slug — try another name');
  }

  // The creator owns the organization they just created.
  await client.query('INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)', [
    orgId,
    userId,
    'OWNER',
  ]);

  await seedDefaultChart(client, orgId);
  await seedStandardPaymentTerms(client, orgId);
  return orgId;
}

/**
 * Takes the organization row's lock for the rest of the transaction, so the
 * "at least one OWNER" check below and the write that follows it are atomic
 * against another member change in the same organization.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`: every insert into a child table
 * (a journal entry, an invoice…) takes `FOR KEY SHARE` on its organization
 * row through the foreign-key check, and `FOR UPDATE` conflicts with that —
 * a member change would briefly stall all posting in the organization.
 * `NO KEY UPDATE` conflicts with itself (serialising member changes) but not
 * with `KEY SHARE`.
 */
export async function lockOrganizationOnClient(client: Queryable, orgId: string): Promise<void> {
  const { rows } = await client.query('SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgId]);
  if (rows.length === 0) throw new ApiError(404, 'Organization not found');
}

async function countOwners(client: Queryable, orgId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM organization_members WHERE org_id = $1 AND role = 'OWNER'",
    [orgId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * The actor's access as of now, read under the organization lock — not the
 * role in their access token, which can be up to 15 minutes stale. Without
 * this, an owner demoted a minute ago could still grant or remove OWNER, and
 * two owners demoting each other could each act on a role they had just lost.
 */
async function currentActorAccess(client: Queryable, orgId: string, actorId: string): Promise<MemberAccess> {
  const access = await resolveMemberAccess(client, orgId, actorId);
  if (access === null || !access.permissions.has('members.manage')) {
    throw new ApiError(403, 'You need the "Invite, change roles and remove members" permission');
  }
  return access;
}

/**
 * Who may touch whose membership (Phase 37, extended in 38c):
 *
 * - Only an OWNER grants, changes or removes the OWNER role — otherwise an
 *   ADMIN could promote themselves past the person who made them ADMIN.
 * - **No privilege escalation.** A non-owner may only manage a member whose
 *   current permissions are a subset of their own, and may only hand out a
 *   role whose permissions are a subset of their own. A custom "Team lead"
 *   role holding `members.manage` therefore cannot make anyone an ADMIN, nor
 *   demote one.
 */
export function assertMayManage(
  actor: MemberAccess,
  target: { role: Role; permissions: ReadonlySet<string> } | null,
  next: { role: Role; permissions: ReadonlySet<string> } | null,
): void {
  if ((target?.role === 'OWNER' || next?.role === 'OWNER') && actor.role !== 'OWNER') {
    throw new ApiError(403, 'Only an owner can grant, change or remove the owner role');
  }
  if (actor.role === 'OWNER') return;
  if (target !== null && !isSubset(target.permissions, actor.permissions)) {
    throw new ApiError(403, 'You cannot change the access of someone with permissions you do not have');
  }
  if (next !== null && !isSubset(next.permissions, actor.permissions)) {
    throw new ApiError(403, 'You cannot give someone permissions you do not have yourself');
  }
}

export async function deleteMembershipOnClient(
  client: Queryable,
  orgId: string,
  userId: string,
  targetRole: Role,
): Promise<void> {
  if (targetRole === 'OWNER' && (await countOwners(client, orgId)) <= 1) {
    throw new ApiError(422, 'An organization must keep at least one owner — make someone else an owner first');
  }
  await client.query('DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
}

/** PATCH /organizations/members/:userId — change a member's role (built-in or custom). */
export async function updateMemberRole(
  orgId: string,
  actor: { id: string },
  targetUserId: string,
  next: { role: Role; customRoleId: string | null },
): Promise<OrganizationMember> {
  await withTransaction(async (client) => {
    await lockOrganizationOnClient(client, orgId);
    const actorAccess = await currentActorAccess(client, orgId, actor.id);
    const current = await resolveMemberAccess(client, orgId, targetUserId);
    if (current === null) throw new ApiError(404, 'Member not found');
    // A custom role id from another organization resolves to null here
    // (scoped by org_id) — and the composite FK refuses it regardless.
    const nextPermissions = await permissionsOfRole(client, orgId, next);
    if (nextPermissions === null) throw new ApiError(404, 'Role not found');
    assertMayManage(actorAccess, current, { role: next.role, permissions: nextPermissions });
    if (current.role === next.role && current.customRoleId === next.customRoleId) return;

    if (current.role === 'OWNER' && (await countOwners(client, orgId)) <= 1) {
      throw new ApiError(422, 'An organization must keep at least one owner — make someone else an owner first');
    }
    await client.query(
      'UPDATE organization_members SET role = $3, custom_role_id = $4 WHERE org_id = $1 AND user_id = $2',
      [orgId, targetUserId, next.role, next.customRoleId],
    );
  });

  const member = (await listMembers(orgId)).find((m) => m.userId === targetUserId);
  if (member === undefined) throw new ApiError(404, 'Member not found');
  return member;
}

/**
 * DELETE /organizations/members/:userId — remove someone else. Removing
 * yourself goes through POST /auth/leave-org instead, which also moves your
 * session to another organization; this route has no session to move.
 *
 * Since Phase 38c a removed member loses access on their next request:
 * every route re-reads membership (`requirePermission`), so the 15-minute
 * access-token window no longer applies to removal.
 */
export async function removeMember(orgId: string, actor: { id: string }, targetUserId: string): Promise<void> {
  if (targetUserId === actor.id) {
    throw new ApiError(422, 'To remove yourself, leave the organization instead');
  }
  await withTransaction(async (client) => {
    await lockOrganizationOnClient(client, orgId);
    const actorAccess = await currentActorAccess(client, orgId, actor.id);
    const current = await resolveMemberAccess(client, orgId, targetUserId);
    if (current === null) throw new ApiError(404, 'Member not found');
    assertMayManage(actorAccess, current, null);
    await deleteMembershipOnClient(client, orgId, targetUserId, current.role);
  });
}
