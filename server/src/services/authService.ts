import bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import { pool } from '../db/connect.js';
import { ApiError } from '../utils/apiError.js';
import { slugify } from '../utils/validate.js';
import { seedDefaultChart } from './ledger-core/accountService.js';
import {
  accessTokenExpiry,
  hashRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/jwt.js';
import { BCRYPT_COST, REFRESH_TOKEN_TTL_MS } from '../config/constants.js';
import {
  isRole,
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
    joined_at: Date;
  }>(
    `SELECT o.id AS org_id, o.name AS org_name, o.slug AS org_slug,
            m.role, m.created_at AS joined_at
       FROM organization_members m
       JOIN organizations o ON o.id = m.org_id
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
    created_at: Date;
  }>('SELECT id, name, slug, base_currency, created_at FROM organizations WHERE id = $1', [orgId]);

  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    // CHAR(3) is blank-padded on read in some drivers; trim defensively.
    baseCurrency: row.base_currency.trim(),
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

  return { user, organization, role, memberships, accessTokenExpiresAt: accessTokenExpiry() };
}

/* ----------------------------------------------------------------- sessions */

/**
 * Signs both tokens and persists the refresh row. Always called with the
 * transaction's own client so the row and whatever else the caller is doing
 * commit or roll back together (rule 5).
 */
async function issueSession(
  client: Queryable,
  userId: string,
  orgId: string,
  role: Role,
): Promise<IssuedSession> {
  const accessToken = signAccessToken({ id: userId, orgId, role });
  const refreshToken = signRefreshToken(userId, orgId);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await client.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, org_id, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, hashRefreshToken(refreshToken), orgId, expiresAt],
  );

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
  organizationName: string;
}

/**
 * Creates the user, their organization, the OWNER membership binding them, and
 * the default 44-account chart of accounts — all or nothing, in one
 * transaction. An organization without a chart cannot post anything, so
 * seeding it is part of creating one, not a follow-up step that could fail on
 * its own and leave a half-usable tenant behind.
 *
 * Registration does not log you in; the client calls /login next. Issuing
 * tokens here would drag session state into the identity transaction for no
 * benefit. It also does not collect LedgerCore's onboarding details (fiscal
 * year, base currency, cash account) — that is `POST
 * /ledger-core/settings/onboarding`, completed once the user picks LedgerCore
 * for the first time (Phase 3.5).
 */
export async function register(input: RegisterInput): Promise<PublicUser> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

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

    // Slug is globally unique and organization names collide constantly
    // ("Acme"). ON CONFLICT DO NOTHING is what makes retrying possible inside
    // a transaction: a caught 23505 would have poisoned the block, forcing a
    // SAVEPOINT round trip per attempt.
    const base = slugify(input.organizationName);
    let orgId: string | undefined;

    for (let attempt = 0; attempt < 5 && orgId === undefined; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(16).slice(2, 8)}`;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO organizations (name, slug) VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [input.organizationName, candidate],
      );
      orgId = rows[0]?.id;
    }

    if (orgId === undefined) {
      throw new ApiError(409, 'Could not allocate a unique organization slug — try another name');
    }

    // The creator owns the organization they just created.
    await client.query(
      'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
      [orgId, userId, 'OWNER'],
    );

    // An organization without a chart of accounts cannot post anything, so the
    // chart is part of creating one — not a follow-up step that could fail on
    // its own and leave a half-usable tenant behind.
    //
    // `client`, never `pool`: a stray pool.query here would run on a different
    // connection and commit immediately, leaving a chart of accounts behind for
    // an organization that the rollback erased (guardrails rule 5).
    await seedDefaultChart(client, orgId);

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
    await client.query('BEGIN');

    // LOWER(email) on both sides, matching the ux_users_email_lower index.
    // The prior build matched exactly here and case-insensitively on register,
    // which locked people out of accounts they had successfully created.
    const { rows } = await client.query<{ id: string; password: string }>(
      'SELECT id, password FROM users WHERE LOWER(email) = LOWER($1)',
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

    const memberships = await listMemberships(client, row.id);
    const { orgId, role } = resolveActiveOrg(memberships, null);

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
    await client.query('BEGIN');

    const { rows } = await client.query<{ user_id: string; org_id: string | null; expires_at: Date }>(
      'DELETE FROM refresh_tokens WHERE token_hash = $1 RETURNING user_id, org_id, expires_at',
      [hashRefreshToken(token)],
    );
    const row = rows[0];

    if (row === undefined) {
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [claims.userId]);
      await client.query('COMMIT');
      throw new ApiError(401, 'Refresh token has already been used — please sign in again');
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

    const issued = await issueSession(client, row.user_id, orgId, role);
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
    await client.query('BEGIN');

    const role = await findMembershipRole(client, userId, targetOrgId);
    if (role === null) {
      // 403 and not 404: revealing whether the org exists would let any user
      // probe for organization ids.
      throw new ApiError(403, 'You are not a member of that organization');
    }

    if (currentRefreshToken !== null) {
      await client.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [
        hashRefreshToken(currentRefreshToken),
      ]);
    }

    const issued = await issueSession(client, userId, targetOrgId, role);
    await client.query('COMMIT');
    return issued;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
