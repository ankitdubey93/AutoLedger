import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { hashRefreshToken } from '../utils/jwt.js';
import { env } from '../config/env.js';
import { enqueueEmailOnClient } from './mail/emailOutboxService.js';
import { notifyInvitationAcceptedOnClient } from './mail/notificationService.js';
import { INVITATION_TTL_MS } from '../config/constants.js';
import { isRole, type Role } from '../types/auth.js';
import { permissionsOfRole, resolveMemberAccess } from './permissionService.js';
import { assertMayManage } from './organizationService.js';
import {
  canTransitionInvitation,
  type Invitation,
  type InvitationPreview,
  type InvitationStatus,
} from '../types/organization.js';

/**
 * Phase 37 — invitations into an organization. See docs/architecture.md
 * § Invitations.
 *
 * An invitation names an email and a role. Its token is a bearer credential
 * delivered by email (Phase 38b, through the outbox) and also shown once to
 * the inviter as a fallback link, so
 * only its SHA-256 is stored — the same treatment refresh and password-reset
 * tokens get. Accepting requires **both** the token and a signed-in account
 * whose email matches: emails are not verified in this codebase, so matching
 * on email alone would hand the invite to whoever registered that address
 * first, and the token alone would let a forwarded link admit anyone.
 *
 * Status is derived from timestamps (`statusOf`) and every move goes through
 * `canTransitionInvitation` (guardrails rule 10).
 */

type Queryable = Pick<PoolClient, 'query'>;

/** Postgres unique-violation. */
const PG_UNIQUE_VIOLATION = '23505';

interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function statusOf(row: Pick<InvitationRow, 'expires_at' | 'accepted_at' | 'revoked_at'>, now = Date.now()): InvitationStatus {
  if (row.accepted_at !== null) return 'ACCEPTED';
  if (row.revoked_at !== null) return 'REVOKED';
  if (row.expires_at.getTime() <= now) return 'EXPIRED';
  return 'PENDING';
}

function roleOf(value: string): Role {
  // The CHECK constraint guarantees this; a silent cast would hide a future
  // migration that widened the column.
  if (!isRole(value)) throw new Error(`Unknown invitation role "${value}"`);
  return value;
}

/** The link an inviter copies. Built from FRONTEND_URL, never from the request's Host. */
function acceptUrlFor(token: string): string {
  return `${new URL(env.FRONTEND_URL).origin}/invite/${token}`;
}

/* ------------------------------------------------------------------ inviter */

/**
 * POST /organizations/invitations. Returns the invitation and its link —
 * the only time the raw token exists outside the inviter's clipboard.
 *
 * - An ADMIN cannot invite an OWNER (only an OWNER grants OWNER).
 * - An address that is already a member is refused (409).
 * - An address with a live pending invitation is refused (409). An expired
 *   one is revoked first, in the same transaction, so re-inviting after
 *   expiry just works and the partial unique index never blocks it.
 */
export async function createInvitation(
  orgId: string,
  inviter: { id: string },
  input: { email: string; role: Role; customRoleId: string | null },
): Promise<{ invitation: Invitation; acceptUrl: string }> {
  const email = input.email.toLowerCase();
  const token = randomBytes(32).toString('base64url');

  const invitation = await withTransaction(async (client) => {
    // The inviter's access is re-read here, not taken from the access token,
    // which can be up to 15 minutes stale: an owner demoted a minute ago must
    // not still be able to invite an owner. Phase 38c: the same
    // no-escalation rule as changing a member's role — you can only invite
    // someone into a role whose permissions you hold yourself.
    const inviterAccess = await resolveMemberAccess(client, orgId, inviter.id);
    if (inviterAccess === null || !inviterAccess.permissions.has('members.manage')) {
      throw new ApiError(403, 'You need the "Invite, change roles and remove members" permission');
    }
    const rolePermissions = await permissionsOfRole(client, orgId, input);
    if (rolePermissions === null) throw new ApiError(404, 'Role not found');
    assertMayManage(inviterAccess, null, { role: input.role, permissions: rolePermissions });

    const { rows: memberRows } = await client.query(
      `SELECT 1
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND LOWER(u.email) = $2`,
      [orgId, email],
    );
    if (memberRows.length > 0) {
      throw new ApiError(409, `${email} is already a member of this organization`);
    }

    // EXPIRED -> REVOKED (INVITATION_TRANSITIONS): closing out a row the clock
    // already expired frees the partial unique index for the new invite. The
    // WHERE clause selects exactly the EXPIRED rows.
    await client.query(
      `UPDATE organization_invitations SET revoked_at = now()
        WHERE org_id = $1 AND email = $2
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
      [orgId, email],
    );

    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO organization_invitations (org_id, email, role, custom_role_id, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          orgId,
          email,
          input.role,
          input.customRoleId,
          hashRefreshToken(token),
          inviter.id,
          new Date(Date.now() + INVITATION_TTL_MS),
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('INSERT ... RETURNING produced no row');

      // Phase 38b — the invitation email, on this same transaction: if the
      // insert rolls back, no email about it can exist (rule 5).
      const { rows: ctxRows } = await client.query<{ org_name: string; inviter_name: string; role_name: string | null }>(
        `SELECT o.name AS org_name, COALESCE(u.name, u.email) AS inviter_name,
                (SELECT r.name FROM org_roles r WHERE r.org_id = o.id AND r.id = $3::uuid) AS role_name
           FROM organizations o, users u
          WHERE o.id = $1 AND u.id = $2`,
        [orgId, inviter.id, input.customRoleId],
      );
      await enqueueEmailOnClient(client, {
        orgId,
        to: email,
        template: 'invitation',
        data: {
          organizationName: ctxRows[0]?.org_name ?? '',
          inviterName: ctxRows[0]?.inviter_name ?? 'Someone',
          roleLabel: ctxRows[0]?.role_name ?? input.role,
        },
        link: acceptUrlFor(token),
      });
      return loadInvitation(client, orgId, id);
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === PG_UNIQUE_VIOLATION) {
        throw new ApiError(409, `${email} already has a pending invitation — revoke it to send a new one`);
      }
      throw err;
    }
  });

  // Phase 38b — the invitation is emailed (above); the link is still
  // returned this once, as a fallback the inviter can copy if the email
  // does not arrive.
  return { invitation, acceptUrl: acceptUrlFor(token) };
}

async function loadInvitation(q: Queryable, orgId: string, id: string): Promise<Invitation> {
  const list = await selectInvitations(q, orgId, id);
  const invitation = list[0];
  if (invitation === undefined) throw new ApiError(404, 'Invitation not found');
  return invitation;
}

async function selectInvitations(q: Queryable, orgId: string, id: string | null): Promise<Invitation[]> {
  const { rows } = await q.query<
    InvitationRow & { invited_by_name: string | null; custom_role_id: string | null; custom_role_name: string | null }
  >(
    `SELECT i.id, i.org_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
            COALESCE(u.name, u.email) AS invited_by_name, i.custom_role_id, r.name AS custom_role_name
       FROM organization_invitations i
       LEFT JOIN users u ON u.id = i.invited_by
       LEFT JOIN org_roles r ON r.org_id = i.org_id AND r.id = i.custom_role_id
      WHERE i.org_id = $1
        AND ($2::uuid IS NULL OR i.id = $2::uuid)
        AND ($2::uuid IS NOT NULL OR (i.accepted_at IS NULL AND i.revoked_at IS NULL))
      ORDER BY i.created_at DESC`,
    [orgId, id],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: roleOf(r.role),
    customRoleId: r.custom_role_id,
    roleName: r.role === 'CUSTOM' ? (r.custom_role_name ?? 'Custom role') : r.role,
    status: statusOf(r),
    invitedByName: r.invited_by_name,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  }));
}

/** GET /organizations/invitations — open invitations (pending, or expired and not yet closed out). */
export async function listInvitations(orgId: string): Promise<Invitation[]> {
  return selectInvitations(pool, orgId, null);
}

/**
 * DELETE /organizations/invitations/:id. Scoped by `org_id`, so another
 * organization's invitation id is a 404, never a revoke (rule 1).
 */
export async function revokeInvitation(orgId: string, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<InvitationRow>(
      `SELECT id, org_id, email, role, expires_at, accepted_at, revoked_at, created_at
         FROM organization_invitations
        WHERE org_id = $1 AND id = $2
        FOR UPDATE`,
      [orgId, id],
    );
    const row = rows[0];
    if (row === undefined) throw new ApiError(404, 'Invitation not found');

    const from = statusOf(row);
    if (!canTransitionInvitation(from, 'REVOKED')) {
      throw new ApiError(409, `This invitation is already ${from.toLowerCase()}`);
    }
    await client.query('UPDATE organization_invitations SET revoked_at = now() WHERE org_id = $1 AND id = $2', [
      orgId,
      id,
    ]);
  });
}

/* ------------------------------------------------------------------ invitee */

/**
 * GET /invitations/:token — public. Looked up by token hash, so this is
 * org-less by construction: possessing the token is the authorization to
 * see which organization it is for. A wrong token is a 404 that says
 * nothing about why.
 */
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const { rows } = await pool.query<
    InvitationRow & { org_name: string; invited_by_name: string | null; custom_role_name: string | null }
  >(
    `SELECT i.id, i.org_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at,
            o.name AS org_name, COALESCE(u.name, u.email) AS invited_by_name, r.name AS custom_role_name
       FROM organization_invitations i
       JOIN organizations o ON o.id = i.org_id
       LEFT JOIN users u ON u.id = i.invited_by
       LEFT JOIN org_roles r ON r.org_id = i.org_id AND r.id = i.custom_role_id
      WHERE i.token_hash = $1`,
    [hashRefreshToken(token)],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'This invitation link is not valid');
  return {
    organizationName: row.org_name,
    invitedByName: row.invited_by_name,
    email: row.email,
    role: roleOf(row.role),
    roleName: row.role === 'CUSTOM' ? (row.custom_role_name ?? 'Custom role') : row.role,
    status: statusOf(row),
    expiresAt: row.expires_at.toISOString(),
  };
}

/**
 * Accepts an invitation for `user` on the caller's transaction: locks the
 * row, checks it is PENDING and addressed to this user's email, creates the
 * membership and marks the invitation accepted. Shared by
 * `authService.acceptInvitation` (a signed-in user) and `authService.register`
 * (a new account created from the link), each of which owns the transaction.
 *
 * `FOR UPDATE` on the invitation serialises two simultaneous accepts of the
 * same link: the second waits, then sees ACCEPTED and gets 410.
 */
export async function acceptInvitationOnClient(
  client: Queryable,
  token: string,
  user: { id: string; email: string },
): Promise<{ orgId: string; role: Role }> {
  const { rows } = await client.query<InvitationRow & { invited_by: string | null; custom_role_id: string | null }>(
    `SELECT id, org_id, email, role, expires_at, accepted_at, revoked_at, created_at, invited_by, custom_role_id
       FROM organization_invitations
      WHERE token_hash = $1
      FOR UPDATE`,
    [hashRefreshToken(token)],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'This invitation link is not valid');

  const from = statusOf(row);
  if (!canTransitionInvitation(from, 'ACCEPTED')) {
    throw new ApiError(410, `This invitation has ${from === 'ACCEPTED' ? 'already been used' : `been ${from.toLowerCase()}`}`);
  }
  if (row.email !== user.email.toLowerCase()) {
    throw new ApiError(403, `This invitation was sent to ${row.email} — sign in with that address to accept it`);
  }

  const { rows: existing } = await client.query(
    'SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2',
    [row.org_id, user.id],
  );
  if (existing.length > 0) throw new ApiError(409, 'You are already a member of this organization');

  const role = roleOf(row.role);
  await client.query('INSERT INTO organization_members (org_id, user_id, role, custom_role_id) VALUES ($1, $2, $3, $4)', [
    row.org_id,
    user.id,
    role,
    row.custom_role_id,
  ]);
  await client.query(
    'UPDATE organization_invitations SET accepted_at = now(), accepted_by = $3 WHERE org_id = $1 AND id = $2',
    [row.org_id, row.id, user.id],
  );

  // Phase 38b — tell the inviter, on this transaction.
  const { rows: memberRows } = await client.query<{ name: string | null }>('SELECT name FROM users WHERE id = $1', [user.id]);
  await notifyInvitationAcceptedOnClient(client, row.org_id, row.invited_by, {
    name: memberRows[0]?.name ?? null,
    email: user.email,
  });
  return { orgId: row.org_id, role };
}
