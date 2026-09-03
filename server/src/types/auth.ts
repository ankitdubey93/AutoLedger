/**
 * Identity and tenancy types. See docs/architecture.md for the model.
 *
 * Convention throughout: a nullable database column is typed `T | null`, never
 * `field?: T`. Under `exactOptionalPropertyTypes` an optional property and a
 * property explicitly set to `undefined` are different types, so `?:` forces
 * conditional-spread gymnastics at every construction site. `| null` also
 * matches what the `pg` driver actually hands back.
 */

/**
 * The four roles, fixed until a module genuinely needs a fifth. Mirrored by a
 * CHECK constraint in migration 001 — application validation and a database
 * constraint are belt and braces, and we write both.
 */
export const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'] as const;

export type Role = (typeof ROLES)[number];

/** Narrows unknown input (a request body, a database string) to a Role. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * What the auth middleware attaches to `req.user`, and exactly what the access
 * token carries. `orgId` is the active organization and comes only from the
 * verified token — never from a header, query param or body (guardrails rule 1).
 */
export interface AuthUser {
  id: string;
  orgId: string;
  role: Role;
}

/** Claims inside a refresh token. `jti` makes each token unique — see utils/jwt.ts. */
export interface RefreshClaims {
  userId: string;
  orgId: string | null;
  jti: string;
}

/* --------------------------------------------------------------- API shapes */

/** A user as the client is allowed to see it. Never includes `password`. */
export interface PublicUser {
  id: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  baseCurrency: string;
  taxNumber: string | null;
  businessNumber: string | null;
  createdAt: string;
}

/** One organization the user belongs to, plus their role in it. */
export interface Membership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: Role;
  joinedAt: string;
}

/** A member of the active organization — the payload of GET /organizations/members. */
export interface OrganizationMember {
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  joinedAt: string;
}

/**
 * The body of GET /auth/check, and what the client's AuthContext stores.
 *
 * `accessTokenExpiresAt` exists because the access token lives in an httpOnly
 * cookie: the browser cannot read it, so the server has to state the expiry
 * for the UI to count down against.
 */
export interface SessionPayload {
  user: PublicUser;
  organization: OrganizationSummary | null;
  role: Role | null;
  memberships: Membership[];
  accessTokenExpiresAt: string;
}

/** What a successful login/refresh hands back to the controller to set cookies with. */
export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  session: SessionPayload;
}
