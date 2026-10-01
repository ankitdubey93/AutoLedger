import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { beginTransaction } from '../db/transaction.js';
import { ApiError } from '../utils/apiError.js';
import { createOrganizationOnClient, deleteMembershipOnClient, lockOrganizationOnClient } from './organizationService.js';
import { acceptInvitationOnClient } from './invitationService.js';
import { resolveMemberAccess } from './permissionService.js';
import {
  accessTokenExpiry,
  hashRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/jwt.js';
import {
  BCRYPT_COST,
  EMAIL_TOKEN_TTL_MS,
  MAX_OWNED_ORGANIZATIONS,
  VERIFY_RESEND_COOLDOWN_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from '../config/constants.js';
import { env } from '../config/env.js';
import { getRequestContext } from '../utils/requestContext.js';
import { enqueueEmailOnClient } from './mail/emailOutboxService.js';
import {
  isRole,
  type ActiveSession,
  type IssuedSession,
  type Membership,
  type OrganizationSummary,
  type PublicUser,
  type Role,
  type SessionPayload,
} from '../types/auth.js';

/**
 * All identity and session SQL. Controllers never query (guardrails rule 2)
 * — the prior build leaked SQL into authController and never got it
 * back out, so authService exists from day one.
 */

/** Both `pool` and a checked-out `PoolClient` satisfy this. */
type Queryable = Pick<PoolClient, 'query'>;

/**
 * Compared against when no user matches the submitted email.
 *
 * Without it, an unknown address returns in ~0ms while a known one costs a
 * full bcrypt comparison, and that difference is a reliable oracle for
 * enumerating which emails have accounts. Hashing a throwaway value makes both
 * paths cost the same. Computed once at import — at BCRYPT_COST 4 under test
 * this is instant, and ~250ms once at boot in production.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equalisation-placeholder', BCRYPT_COST);

/** Postgres unique-violation. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  if (err.code !== PG_UNIQUE_VIOLATION) return false;
  if (constraint === undefined) return true;
  return 'constraint' in err && err.constraint === constraint;
}

/* ------------------------------------------------------------------ loaders */

interface UserRow {
  id: string;
  name: string | null;
  email: string;
  email_verified: boolean;
  created_at: Date;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.email_verified,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadUser(q: Queryable, userId: string): Promise<PublicUser> {
  const { rows } = await q.query<UserRow>(
    'SELECT id, name, email, email_verified, created_at FROM users WHERE id = $1',
    [userId],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(401, 'User no longer exists');
  return toPublicUser(row);
}

/**
 * Every organization this user belongs to.
 *
 * Deliberately scoped by `user_id` and not `org_id`, and that is not a rule-1
 * violation: memberships are the *identity* layer that decides which orgs
 * exist for this caller, so there is no active org to scope by yet. Everything
 * downstream of this is org-scoped. See docs/architecture.md.
 */
export async function listMemberships(q: Queryable, userId: string): Promise<Membership[]> {
  const { rows } = await q.query<{
    org_id: string;
    org_name: string;
    org_slug: string;
    role: string;
    custom_role_name: string | null;
    joined_at: Date;
  }>(
    `SELECT o.id AS org_id, o.name AS org_name, o.slug AS org_slug,
            m.role, r.name AS custom_role_name, m.created_at AS joined_at
       FROM organization_members m
       JOIN organizations o ON o.id = m.org_id
       LEFT JOIN org_roles r ON r.org_id = m.org_id AND r.id = m.custom_role_id
      WHERE m.user_id = $1
      ORDER BY m.created_at ASC`,
    [userId],
  );

  return rows.map((r) => {
    // The CHECK constraint guarantees this, but the driver hands back `string`
    // and a silent cast would hide a future migration that widened the column.
    if (!isRole(r.role)) throw new Error(`Unknown role "${r.role}" for org ${r.org_id}`);
    return {
      orgId: r.org_id,
      orgName: r.org_name,
      orgSlug: r.org_slug,
      role: r.role,
      roleName: r.role === 'CUSTOM' ? (r.custom_role_name ?? 'Custom role') : r.role,
      joinedAt: r.joined_at.toISOString(),
    };
  });
}

/** The caller's role in one organization, or null when they are not a member. */
async function findMembershipRole(
  q: Queryable,
  userId: string,
  orgId: string,
): Promise<Role | null> {
  const { rows } = await q.query<{ role: string }>(
    'SELECT role FROM organization_members WHERE user_id = $1 AND org_id = $2',
    [userId, orgId],
  );
  const row = rows[0];
  if (row === undefined || !isRole(row.role)) return null;
  return row.role;
}

async function loadOrganization(q: Queryable, orgId: string): Promise<OrganizationSummary | null> {
  const { rows } = await q.query<{
    id: string;
    name: string;
    slug: string;
    base_currency: string;
    tax_number: string | null;
    business_number: string | null;
    created_at: Date;
  }>(
    'SELECT id, name, slug, base_currency, tax_number, business_number, created_at FROM organizations WHERE id = $1',
    [orgId],
  );

  const row = rows[0];
  if (row === undefined) return null;
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

/** Assembles GET /auth/check's body. */
export async function buildSession(
  q: Queryable,
  userId: string,
  orgId: string | null,
): Promise<SessionPayload> {
  const [user, memberships] = await Promise.all([loadUser(q, userId), listMemberships(q, userId)]);
  const organization = orgId === null ? null : await loadOrganization(q, orgId);
  const role = memberships.find((m) => m.orgId === orgId)?.role ?? null;
  // Phase 38c — the active organization's permissions, for the client to
  // hide what the server would refuse. Every route re-checks regardless.
  const access = orgId === null ? null : await resolveMemberAccess(q, orgId, userId);

  return {
    user,
    organization,
    role,
    roleName: access?.roleName ?? null,
    permissions: access === null ? [] : [...access.permissions].sort(),
    memberships,
    accessTokenExpiresAt: accessTokenExpiry(),
  };
}

/* ----------------------------------------------------------------- sessions */

/**
 * Phase 38a — the browser session a refresh row belongs to. Minted at login
 * and carried forward through every rotation and org move, so one browser is
 * one row in the sessions list however often its tokens rotate.
 */
interface SessionCarry {
  sessionId: string;
  startedAt: Date;
}

/**
 * Deletes the presented refresh row and returns the session it belonged to,
 * so the replacement row can carry it forward. Scoped by `user_id` too: a
 * cookie that somehow belongs to another identity retires nothing.
 */
async function retireRefreshRow(
  client: Queryable,
  userId: string,
  refreshToken: string | null,
): Promise<SessionCarry | null> {
  if (refreshToken === null) return null;
  const { rows } = await client.query<{ session_id: string; session_started_at: Date; revoked_at: Date | null }>(
    'DELETE FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2 RETURNING session_id, session_started_at, revoked_at',
    [hashRefreshToken(refreshToken), userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  // A browser signed out from another device still holds a valid access
  // token for up to 15 minutes; it must not use it to mint a fresh session.
  if (row.revoked_at !== null) throw new ApiError(401, 'This session was signed out');
  return { sessionId: row.session_id, startedAt: row.session_started_at };
}

/**
 * Signs both tokens and persists the refresh row. Always called with the
 * transaction's own client so the row and whatever else the caller is doing
 * commit or roll back together (rule 5).
 *
 * `carry` continues an existing session (rotation, switch, create, accept,
 * leave); null starts a new one (login). The device description comes from
 * the request context, refreshed on every issue.
 */
async function issueSession(
  client: Queryable,
  userId: string,
  orgId: string,
  role: Role,
  carry: SessionCarry | null = null,
): Promise<IssuedSession> {
  const accessToken = signAccessToken({ id: userId, orgId, role });
  const refreshToken = signRefreshToken(userId, orgId);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const ctx = getRequestContext();

  await client.query(
    `INSERT INTO refresh_tokens
       (user_id, token_hash, org_id, expires_at, session_id, session_started_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, COALESCE($5::uuid, gen_random_uuid()), COALESCE($6::timestamptz, now()), $7, $8)`,
    [
      userId,
      hashRefreshToken(refreshToken),
      orgId,
      expiresAt,
      carry?.sessionId ?? null,
      carry?.startedAt ?? null,
      ctx?.userAgent ?? null,
      ctx?.ip ?? null,
    ],
  );

  // Phase 37 — every session issue (login, refresh, switch, create, accept,
  // leave) records the organization it opened in, so the next login opens
  // there too. One write site, so no flow can forget it.
  await client.query('UPDATE users SET last_active_org_id = $2 WHERE id = $1', [userId, orgId]);

  const session = await buildSession(client, userId, orgId);
  return { accessToken, refreshToken, session };
}

/**
 * Picks the organization a new session should open in: the one requested if the
 * user is still a member, otherwise their oldest remaining membership.
 *
 * The fallback matters on refresh — a user removed from their active org
 * between token issue and refresh should land somewhere sensible rather than
 * holding a token for an org they no longer belong to.
 */
function resolveActiveOrg(
  memberships: Membership[],
  preferredOrgId: string | null,
): { orgId: string; role: Role } {
  const preferred =
    preferredOrgId === null ? undefined : memberships.find((m) => m.orgId === preferredOrgId);
  const chosen = preferred ?? memberships[0];

  if (chosen === undefined) {
    throw new ApiError(403, 'You do not belong to any organization');
  }
  return { orgId: chosen.orgId, role: chosen.role };
}

/* ----------------------------------------------------------------- register */

export interface RegisterInput {
  name: string | null;
  email: string;
  password: string;
  /**
   * Exactly one of these two (Phase 37). `organizationName` creates the new
   * user's own organization; `inviteToken` joins the organization that
   * invited them instead, creating none.
   */
  organizationName: string | null;
  inviteToken?: string | null;
}

/**
 * Creates the user and either their own organization (OWNER, default chart
 * of accounts, payment terms — `createOrganizationOnClient`) or, given an
 * invite token, their membership in the inviting organization — all or
 * nothing, in one transaction. A bad or mismatched invite rolls the user
 * back too, so no orphan account without an organization is left behind.
 *
 * Registration does not log you in; the client calls /login next. Issuing
 * tokens here would drag session state into the identity transaction for no
 * benefit. Accounting's onboarding details (fiscal year, base currency, cash
 * account) are the setup wizard's job (`POST /settings/onboarding`).
 */
export async function register(input: RegisterInput): Promise<PublicUser> {
  const inviteToken = input.inviteToken ?? null;
  if ((inviteToken === null) === (input.organizationName === null)) {
    throw new ApiError(400, 'Provide either an organization name or an invitation, not both');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const client = await pool.connect();

  try {
    await beginTransaction(client);

    // First statement in the transaction, deliberately. A unique violation
    // aborts the whole block, so there is nothing to preserve when it fires —
    // we roll back and report 409.
    let userId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id',
        [input.name, input.email, passwordHash],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING produced no row');
      userId = row.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(409, 'An account with that email already exists');
      }
      throw err;
    }

    if (inviteToken !== null) {
      await acceptInvitationOnClient(client, inviteToken, { id: userId, email: input.email });
    } else if (input.organizationName !== null) {
      // `client`, never `pool` (rule 5) — see createOrganizationOnClient.
      await createOrganizationOnClient(client, userId, input.organizationName);
    }

    // Phase 38b — a verification email, on the same transaction.
    await issueEmailTokenOnClient(client, userId, 'VERIFY', input.email, input.name);

    const user = await loadUser(client, userId);
    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------- login */

export async function login(email: string, password: string): Promise<IssuedSession> {
  const client = await pool.connect();

  try {
    await beginTransaction(client);

    // LOWER(email) on both sides, matching the ux_users_email_lower index.
    // The prior build matched exactly here and case-insensitively on register,
    // which locked people out of accounts they had successfully created.
    const { rows } = await client.query<{ id: string; password: string; last_active_org_id: string | null }>(
      'SELECT id, password, last_active_org_id FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );
    const row = rows[0];

    // Always run a comparison, even with no user, so both paths cost the same.
    const matches = await bcrypt.compare(password, row?.password ?? DUMMY_PASSWORD_HASH);
    if (row === undefined || !matches) {
      // One message for both causes — saying which was wrong confirms whether
      // an account exists.
      throw new ApiError(401, 'Invalid email or password');
    }

    // Phase 37 — open in the organization used last. resolveActiveOrg
    // re-validates the membership, so a stale id (the user has since left or
    // been removed) falls back to the oldest membership.
    const memberships = await listMemberships(client, row.id);
    const { orgId, role } = resolveActiveOrg(memberships, row.last_active_org_id);

    const issued = await issueSession(client, row.id, orgId, role);
    await client.query('COMMIT');
    return issued;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ refresh */

/**
 * Verifies, consumes and replaces a refresh token.
 *
 * The row is claimed with the DELETE itself rather than SELECT-then-DELETE. A
 * read followed by a write lets two concurrent refreshes both see the row and
 * both succeed; `DELETE ... RETURNING` is atomic, so exactly one transaction
 * gets the row and the other blocks on the row lock and then sees zero rows.
 *
 * Zero rows alongside a *valid signature* is therefore not an error case — it
 * means this token was already rotated, i.e. it is being replayed. That gives
 * reuse detection for free, with no extra state. The response is to drop the
 * user's whole token family: if a token leaked, every session derived from it
 * is suspect.
 *
 * Known trade-off: two tabs refreshing in the same instant both present the
 * pre-rotation cookie, and the loser is logged out everywhere. The client's
 * single-flight wrapper closes the common case; the cross-tab window stays
 * narrow because the cookie jar is shared.
 */
export async function rotateRefreshToken(token: string): Promise<IssuedSession> {
  // Signature first — a forged token never reaches the database.
  const claims = verifyRefreshToken(token);
  const client = await pool.connect();

  try {
    await beginTransaction(client);

    const { rows } = await client.query<{
      user_id: string;
      org_id: string | null;
      expires_at: Date;
      session_id: string;
      session_started_at: Date;
      revoked_at: Date | null;
    }>(
      'DELETE FROM refresh_tokens WHERE token_hash = $1 RETURNING user_id, org_id, expires_at, session_id, session_started_at, revoked_at',
      [hashRefreshToken(token)],
    );
    const row = rows[0];

    if (row === undefined) {
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [claims.userId]);
      await client.query('COMMIT');
      throw new ApiError(401, 'Refresh token has already been used — please sign in again');
    }

    // Phase 38a — signed out from another device (sessions list, password
    // change). Refused quietly: unlike a replay, this is not evidence of
    // theft, so the user's other sessions are left alone. The tombstone is
    // consumed by the DELETE above; the controller clears the cookies.
    if (row.revoked_at !== null) {
      await client.query('COMMIT');
      throw new ApiError(401, 'This session was signed out');
    }

    // Belt and braces with the JWT's own exp: a clock change or a token issued
    // before a TTL change should not outlive its row.
    if (row.expires_at.getTime() < Date.now()) {
      await client.query('COMMIT');
      throw new ApiError(401, 'Refresh token has expired');
    }

    // Re-checked on every refresh: membership may have been revoked since the
    // token was issued, and the token itself carries no way to know that.
    const memberships = await listMemberships(client, row.user_id);
    const { orgId, role } = resolveActiveOrg(memberships, row.org_id);

    const issued = await issueSession(client, row.user_id, orgId, role, {
      sessionId: row.session_id,
      startedAt: row.session_started_at,
    });
    await client.query('COMMIT');
    return issued;
  } catch (err) {
    // The reuse and expiry paths COMMIT before throwing, so their deletions
    // stick; ROLLBACK on an already-finished transaction is a harmless no-op.
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* --------------------------------------------------------------- switch org */

/**
 * Re-issues a session scoped to a different organization.
 *
 * Membership is re-validated here, which is the whole point: the active org
 * comes from the signed token, so this endpoint is the only way it changes.
 *
 * The refresh token is rotated too. If only the access token moved, the next
 * silent refresh would read the stale `org_id` off the old refresh row and
 * quietly drag the user back to the previous organization.
 */
export async function switchOrg(
  userId: string,
  targetOrgId: string,
  currentRefreshToken: string | null,
): Promise<IssuedSession> {
  const client = await pool.connect();

  try {
    await beginTransaction(client);

    const role = await findMembershipRole(client, userId, targetOrgId);
    if (role === null) {
      // 403 and not 404: revealing whether the org exists would let any user
      // probe for organization ids.
      throw new ApiError(403, 'You are not a member of that organization');
    }

    const carry = await retireRefreshRow(client, userId, currentRefreshToken);
    const issued = await issueSession(client, userId, targetOrgId, role, carry);
    await client.query('COMMIT');
    return issued;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------- Phase 37 — organizations */

/**
 * Runs `fn` in a transaction and then hands the session over to `targetOrg`:
 * the presented refresh row is deleted and a fresh pair is issued, exactly
 * as `switchOrg` does (rotating only the access token would let the next
 * silent refresh drag the user back via the old row's `org_id`).
 */
async function inTransactionThenSwitch(
  userId: string,
  currentRefreshToken: string | null,
  fn: (client: PoolClient) => Promise<{ orgId: string; role: Role }>,
): Promise<IssuedSession> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const target = await fn(client);
    const carry = await retireRefreshRow(client, userId, currentRefreshToken);
    const issued = await issueSession(client, userId, target.orgId, target.role, carry);
    await client.query('COMMIT');
    return issued;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /organizations — an existing user adds another organization they own,
 * and the session moves into it. The new organization has no
 * `ledger_settings` row, so the client's setup gate sends the user straight
 * into its own setup wizard.
 *
 * Capped at MAX_OWNED_ORGANIZATIONS. The user row is locked first (`NO KEY
 * UPDATE`, which does not block the many FK checks that reference users) so
 * two concurrent creates cannot both pass the count.
 */
export async function createOrganization(
  userId: string,
  name: string,
  currentRefreshToken: string | null,
): Promise<IssuedSession> {
  return inTransactionThenSwitch(userId, currentRefreshToken, async (client) => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
    const { rows } = await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM organization_members WHERE user_id = $1 AND role = 'OWNER'",
      [userId],
    );
    if ((rows[0]?.n ?? 0) >= MAX_OWNED_ORGANIZATIONS) {
      throw new ApiError(422, `You can own at most ${String(MAX_OWNED_ORGANIZATIONS)} organizations`);
    }
    const orgId = await createOrganizationOnClient(client, userId, name);
    return { orgId, role: 'OWNER' };
  });
}

/**
 * POST /invitations/:token/accept — a signed-in user joins the inviting
 * organization and the session moves into it. The checks (pending, email
 * match, not already a member) live in `acceptInvitationOnClient`.
 */
export async function acceptInvitation(
  userId: string,
  token: string,
  currentRefreshToken: string | null,
): Promise<IssuedSession> {
  return inTransactionThenSwitch(userId, currentRefreshToken, async (client) => {
    const user = await loadUser(client, userId);
    return acceptInvitationOnClient(client, token, { id: user.id, email: user.email });
  });
}

/**
 * POST /organizations/leave — the caller removes their own membership in the
 * active organization and the session moves to their oldest remaining one.
 *
 * Refused for the last OWNER (the organization would be ownerless) and for a
 * user's only organization: a session must carry an org, so a user with none
 * could not sign in again to create or join another.
 */
export async function leaveOrganization(
  userId: string,
  orgId: string,
  currentRefreshToken: string | null,
): Promise<IssuedSession> {
  return inTransactionThenSwitch(userId, currentRefreshToken, async (client) => {
    await lockOrganizationOnClient(client, orgId);
    const memberships = await listMemberships(client, userId);
    const current = memberships.find((m) => m.orgId === orgId);
    if (current === undefined) throw new ApiError(403, 'You are not a member of that organization');

    const remaining = memberships.filter((m) => m.orgId !== orgId);
    if (remaining.length === 0) {
      throw new ApiError(422, 'This is your only organization — create or join another before leaving it');
    }
    await deleteMembershipOnClient(client, orgId, userId, current.role);
    return resolveActiveOrg(remaining, null);
  });
}

/* ------------------------------------------------------------------- logout */

/**
 * Deletes the session's refresh row. Idempotent by design — logging out twice,
 * or with a token that was already rotated away, is a success, not an error.
 *
 * The access token stays valid until it expires (up to 15 minutes). Checking a
 * denylist on every request would undo the reason for stateless access tokens;
 * the short TTL is the mitigation. Documented in docs/architecture.md.
 */
export async function logout(refreshToken: string | null): Promise<void> {
  if (refreshToken === null) return;
  await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [
    hashRefreshToken(refreshToken),
  ]);
}

/** GET /auth/check — the session as the client sees it. */
export async function getSession(userId: string, orgId: string): Promise<SessionPayload> {
  return buildSession(pool, userId, orgId);
}

/* ------------------------------------------- Phase 38a — self-service */

/*
 * Everything below is scoped by `user_id`, not `org_id`, and that is not a
 * rule-1 violation: a password, a name and a set of signed-in browsers belong
 * to the identity, which precedes every organization (the same reasoning as
 * `listMemberships`). The caller's id always comes from the verified token.
 */

/** PATCH /auth/me — the caller's own display name. */
export async function updateProfile(userId: string, input: { name: string | null }): Promise<PublicUser> {
  const { rowCount } = await pool.query('UPDATE users SET name = $2 WHERE id = $1', [userId, input.name]);
  if (rowCount === 0) throw new ApiError(401, 'User no longer exists');
  return loadUser(pool, userId);
}

/**
 * POST /auth/change-password — while signed in. Requires the current
 * password (a borrowed, unlocked laptop must not be enough to take the
 * account over), then signs the user out of **every other** session and any
 * outstanding reset link, keeping this one. Other sessions are revoked as
 * tombstones (migration 081), not deleted, so their next refresh is refused
 * quietly instead of tripping reuse detection.
 *
 * A wrong current password is 400, not 401: this route is authenticated, and
 * the client treats a 401 as "access token expired" — it would refresh,
 * replay, and eventually sign the user out for a typo.
 *
 * bcrypt runs before BEGIN (both the compare and the new hash), so the
 * transaction never holds a connection for ~200ms of hashing.
 */
export async function changePassword(
  userId: string,
  currentRefreshToken: string | null,
  currentPassword: string,
  newPassword: string,
): Promise<{ signedOutSessions: number }> {
  const { rows } = await pool.query<{ password: string }>('SELECT password FROM users WHERE id = $1', [userId]);
  const row = rows[0];
  if (row === undefined) throw new ApiError(401, 'User no longer exists');
  if (!(await bcrypt.compare(currentPassword, row.password))) {
    throw new ApiError(400, 'Your current password is incorrect');
  }
  if (currentPassword === newPassword) {
    throw new ApiError(400, 'Choose a password different from your current one');
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);

  const client = await pool.connect();
  try {
    await beginTransaction(client);
    await client.query('UPDATE users SET password = $2 WHERE id = $1', [userId, passwordHash]);
    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
    const { rowCount } = await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2)`,
      [userId, currentRefreshToken === null ? null : hashRefreshToken(currentRefreshToken)],
    );
    await client.query('COMMIT');
    return { signedOutSessions: rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** GET /auth/sessions — the caller's live sessions, newest activity first. */
export async function listSessions(userId: string, currentRefreshToken: string | null): Promise<ActiveSession[]> {
  const currentHash = currentRefreshToken === null ? null : hashRefreshToken(currentRefreshToken);
  const { rows } = await pool.query<{
    session_id: string;
    session_started_at: Date;
    created_at: Date;
    user_agent: string | null;
    ip: string | null;
    org_name: string | null;
    is_current: boolean;
  }>(
    `SELECT r.session_id, r.session_started_at, r.created_at, r.user_agent, r.ip,
            o.name AS org_name, (r.token_hash = $2) AS is_current
       FROM refresh_tokens r
       LEFT JOIN organizations o ON o.id = r.org_id
      WHERE r.user_id = $1 AND r.expires_at > now() AND r.revoked_at IS NULL
      ORDER BY r.created_at DESC`,
    [userId, currentHash],
  );
  return rows.map((r) => ({
    id: r.session_id,
    startedAt: r.session_started_at.toISOString(),
    lastActiveAt: r.created_at.toISOString(),
    userAgent: r.user_agent,
    ip: r.ip,
    organizationName: r.org_name,
    current: r.is_current === true,
  }));
}

/**
 * DELETE /auth/sessions/:id — sign one other browser out. Another user's
 * session id is a 404 (the `user_id` predicate), and so is an unknown one.
 * The current session is refused: signing yourself out is /auth/logout,
 * which also clears the cookies.
 *
 * The revoked browser's access token stays valid until it expires (up to 15
 * minutes) — the same stated trade-off as logout (docs/architecture.md).
 */
export async function revokeSession(
  userId: string,
  sessionId: string,
  currentRefreshToken: string | null,
): Promise<void> {
  const currentHash = currentRefreshToken === null ? null : hashRefreshToken(currentRefreshToken);
  const { rows } = await pool.query<{ is_current: boolean }>(
    'SELECT (token_hash = $3) AS is_current FROM refresh_tokens WHERE user_id = $1 AND session_id = $2 AND revoked_at IS NULL',
    [userId, sessionId, currentHash],
  );
  const row = rows[0];
  if (row === undefined) throw new ApiError(404, 'Session not found');
  if (row.is_current) throw new ApiError(422, 'This is your current session — sign out instead');
  // A tombstone, not a delete — see migration 081: deleting would make the
  // revoked browser's next refresh look like token theft and sign out every
  // session, this one included.
  await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND session_id = $2', [
    userId,
    sessionId,
  ]);
}

/** POST /auth/sessions/revoke-others — sign out everywhere except here. */
export async function revokeOtherSessions(
  userId: string,
  currentRefreshToken: string | null,
): Promise<{ signedOutSessions: number }> {
  const { rowCount } = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2)`,
    [userId, currentRefreshToken === null ? null : hashRefreshToken(currentRefreshToken)],
  );
  return { signedOutSessions: rowCount ?? 0 };
}

/* ------------------------------------------- Phase 38b — email address */

function frontendUrl(path: string): string {
  return `${new URL(env.FRONTEND_URL).origin}${path}`;
}

/**
 * Mints a verification or change-of-email token for `email` and enqueues
 * the email carrying it, on the caller's transaction. Earlier tokens of the
 * same purpose are deleted, so only the newest link works. Only the token's
 * SHA-256 is stored, as for reset and refresh tokens.
 */
async function issueEmailTokenOnClient(
  client: Queryable,
  userId: string,
  purpose: 'VERIFY' | 'CHANGE',
  email: string,
  name: string | null,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await client.query('DELETE FROM user_email_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
  await client.query(
    'INSERT INTO user_email_tokens (user_id, purpose, email, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [userId, purpose, email.toLowerCase(), hashRefreshToken(token), new Date(Date.now() + EMAIL_TOKEN_TTL_MS)],
  );
  await enqueueEmailOnClient(client, {
    orgId: null,
    to: email,
    toName: name,
    template: purpose === 'VERIFY' ? 'verify_email' : 'confirm_email_change',
    link: frontendUrl(purpose === 'VERIFY' ? `/verify-email?token=${token}` : `/confirm-email-change?token=${token}`),
  });
}

/**
 * Claims an email token atomically (`DELETE ... RETURNING`, so a link works
 * once). Expired → 400 after the delete commits, as reset does.
 */
async function claimEmailTokenOnClient(
  client: Queryable,
  token: string,
  purpose: 'VERIFY' | 'CHANGE',
): Promise<{ userId: string; email: string; expired: boolean } | null> {
  const { rows } = await client.query<{ user_id: string; email: string; expires_at: Date }>(
    'DELETE FROM user_email_tokens WHERE token_hash = $1 AND purpose = $2 RETURNING user_id, email, expires_at',
    [hashRefreshToken(token), purpose],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { userId: row.user_id, email: row.email, expired: row.expires_at.getTime() <= Date.now() };
}

/**
 * POST /auth/verify-email — public: the token is the proof. Marks the
 * address verified only if it is still the account's address: a link sent
 * before an email change must not verify the new address.
 */
export async function verifyEmail(token: string): Promise<void> {
  const client = await pool.connect();
  let outcome: 'ok' | 'expired' | 'stale';
  try {
    await beginTransaction(client);
    const claimed = await claimEmailTokenOnClient(client, token, 'VERIFY');
    if (claimed === null) throw new ApiError(400, 'This verification link is invalid or has already been used');
    if (claimed.expired) {
      outcome = 'expired';
    } else {
      const { rowCount } = await client.query(
        'UPDATE users SET email_verified = true WHERE id = $1 AND LOWER(email) = $2',
        [claimed.userId, claimed.email],
      );
      outcome = rowCount === 0 ? 'stale' : 'ok';
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (outcome === 'expired') throw new ApiError(400, 'This verification link has expired — send a new one from Account settings');
  if (outcome === 'stale') throw new ApiError(400, 'This link was for an email address your account no longer uses');
}

/**
 * POST /auth/verify-email/resend — signed in, unverified. A one-minute
 * cooldown stops the button being used to flood an inbox (or the free
 * daily sending quota).
 */
export async function resendVerification(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows } = await client.query<{ email: string; name: string | null; email_verified: boolean }>(
      'SELECT email, name, email_verified FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const user = rows[0];
    if (user === undefined) throw new ApiError(401, 'User no longer exists');
    if (user.email_verified) throw new ApiError(409, 'Your email is already verified');

    const { rows: recent } = await client.query(
      `SELECT 1 FROM user_email_tokens
        WHERE user_id = $1 AND purpose = 'VERIFY' AND created_at > now() - ($2::int * interval '1 millisecond')`,
      [userId, VERIFY_RESEND_COOLDOWN_MS],
    );
    if (recent.length > 0) throw new ApiError(429, 'A verification email was sent less than a minute ago');

    await issueEmailTokenOnClient(client, userId, 'VERIFY', user.email, user.name);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /auth/me/email — start changing the sign-in email. Needs the current
 * password (as change-password does: a borrowed session must not be enough
 * to take the account). Nothing changes until the link sent to the NEW
 * address is opened, which proves the user controls it.
 *
 * 409 when the address already has an account. That does tell a signed-in
 * user that an address is registered — an accepted, stated trade-off: the
 * caller is authenticated and rate limited, and the alternative (accept now,
 * fail at confirmation) is a worse experience for the common case.
 */
export async function requestEmailChange(userId: string, newEmail: string, currentPassword: string): Promise<void> {
  const email = newEmail.toLowerCase();
  const { rows } = await pool.query<{ password: string; email: string; name: string | null }>(
    'SELECT password, email, name FROM users WHERE id = $1',
    [userId],
  );
  const user = rows[0];
  if (user === undefined) throw new ApiError(401, 'User no longer exists');
  if (!(await bcrypt.compare(currentPassword, user.password))) {
    throw new ApiError(400, 'Your current password is incorrect');
  }
  if (user.email.toLowerCase() === email) throw new ApiError(400, 'That is already your sign-in email');

  const client = await pool.connect();
  try {
    await beginTransaction(client);
    const { rows: taken } = await client.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (taken.length > 0) throw new ApiError(409, 'An account with that email already exists');
    await issueEmailTokenOnClient(client, userId, 'CHANGE', email, user.name);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /auth/confirm-email-change — public: the token sent to the new
 * address is the proof. Swaps the sign-in email, marks it verified (opening
 * the link proved it), and emails a notice to the OLD address so a hijack
 * is visible to the person who loses the account.
 *
 * The UNIQUE (LOWER(email)) index is the real guard against the address
 * being taken in between: a 23505 here becomes 409.
 */
export async function confirmEmailChange(token: string): Promise<void> {
  const client = await pool.connect();
  let expired = false;
  try {
    await beginTransaction(client);
    const claimed = await claimEmailTokenOnClient(client, token, 'CHANGE');
    if (claimed === null) throw new ApiError(400, 'This link is invalid or has already been used');
    if (claimed.expired) {
      expired = true;
    } else {
      const { rows } = await client.query<{ email: string; name: string | null }>(
        'SELECT email, name FROM users WHERE id = $1 FOR UPDATE',
        [claimed.userId],
      );
      const old = rows[0];
      if (old === undefined) throw new ApiError(400, 'This link is invalid or has already been used');
      try {
        await client.query('UPDATE users SET email = $2, email_verified = true WHERE id = $1', [
          claimed.userId,
          claimed.email,
        ]);
      } catch (err) {
        // The whole transaction rolls back, token claim included, so the
        // link still reports this same 409 if opened again.
        if (isUniqueViolation(err)) throw new ApiError(409, 'That email address now belongs to another account');
        throw err;
      }
      // Pending verification links were for the old address.
      await client.query("DELETE FROM user_email_tokens WHERE user_id = $1 AND purpose = 'VERIFY'", [claimed.userId]);
      await enqueueEmailOnClient(client, {
        orgId: null,
        to: old.email,
        toName: old.name,
        template: 'email_changed_notice',
        data: { newEmail: claimed.email },
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (expired) throw new ApiError(400, 'This link has expired — start the change again from Account settings');
}

/* ----------------------------------------------------------- password reset */

/**
 * POST /auth/forgot-password (2026-09-29). Issues a single-use reset token
 * for the account with this email, if there is one, and delivers the link.
 *
 * Returns nothing either way, and the controller answers 202 either way: the
 * response must not reveal whether an email has an account. (The two paths
 * are not perfectly equal in time — one writes a row — which is an accepted,
 * stated limitation; the login path equalises bcrypt cost because that gap
 * is hundreds of milliseconds, this one is a single indexed insert.)
 *
 * Issuing a token deletes the user's earlier ones, so only the newest link
 * works. The token itself is 256 random bits; only its SHA-256 is stored,
 * exactly as refresh tokens are (utils/jwt.ts's hashRefreshToken).
 *
 * **Delivery (Phase 38b)** is an email-outbox row written in this same
 * transaction (rule 5: no follow-up work after COMMIT); the worker's
 * `email-drain` sends it through MAIL_TRANSPORT.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const client = await pool.connect();

  try {
    await beginTransaction(client);
    const { rows } = await client.query<{ id: string; email: string; name: string | null }>(
      'SELECT id, email, name FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );
    const user = rows[0];
    if (user !== undefined) {
      await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
      await client.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
        user.id,
        hashRefreshToken(token),
        new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
      ]);
      // Phase 38b — delivered through the email outbox, on this transaction.
      await enqueueEmailOnClient(client, {
        orgId: null,
        to: user.email,
        toName: user.name,
        template: 'password_reset',
        link: frontendUrl(`/reset-password?token=${token}`),
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /auth/reset-password (2026-09-29). Consumes a reset token and sets a
 * new password, in one transaction:
 *
 * - the token is claimed with `DELETE ... RETURNING`, so two concurrent uses
 *   cannot both succeed (the same atomic claim `rotateRefreshToken` uses);
 * - an expired token is refused — its row is already gone, so it is never
 *   retried;
 * - every other reset token of the user is deleted, and so is every refresh
 *   token: whoever knew the old password is signed out everywhere.
 *
 * bcrypt runs before BEGIN so the transaction never holds a connection for
 * the hash's ~100ms.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const client = await pool.connect();
  let outcome: 'reset' | 'expired';

  try {
    await beginTransaction(client);
    const { rows } = await client.query<{ user_id: string; expires_at: Date }>(
      'DELETE FROM password_reset_tokens WHERE token_hash = $1 RETURNING user_id, expires_at',
      [hashRefreshToken(token)],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ApiError(400, 'This reset link is invalid or has already been used');
    }

    if (row.expires_at.getTime() <= Date.now()) {
      // Still commit: the delete above is wanted, so an expired token can
      // never be tried again. The error is raised after the transaction ends.
      outcome = 'expired';
    } else {
      await client.query('UPDATE users SET password = $2 WHERE id = $1', [row.user_id, passwordHash]);
      await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [row.user_id]);
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [row.user_id]);
      outcome = 'reset';
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (outcome === 'expired') {
    throw new ApiError(400, 'This reset link has expired — request a new one');
  }
}
