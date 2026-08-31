import { createHash, randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from '../config/constants.js';
import { ApiError } from './apiError.js';
import { isRole, type AuthUser, type RefreshClaims } from '../types/auth.js';

/**
 * The only module that signs, verifies or inspects a raw JWT. Everything else
 * deals in `AuthUser` / `RefreshClaims`.
 *
 * A JWT is signed, not encrypted: the payload is base64url and anyone holding
 * the token can read it. The signature proves we issued it and that it has not
 * been altered — it proves nothing about whether it should still be honoured.
 * That is why access tokens are short-lived and refresh tokens are checked
 * against a database row. See study/security-auth/jwt-and-refresh-rotation.md.
 *
 * Nothing here logs a payload (guardrails rule 11).
 */

/** The two token kinds are signed with different keys — env.ts enforces that they differ. */
export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, orgId: user.orgId, role: user.role }, env.ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

/**
 * `jti` is not decoration. Without it, `sign({sub}, secret, {expiresIn})` is a
 * pure function of the payload and the current second — so logging in twice
 * within the same second produces a byte-identical token, an identical
 * SHA-256, and a UNIQUE violation on `refresh_tokens.token_hash` for a
 * perfectly legitimate action.
 */
export function signRefreshToken(userId: string, orgId: string | null): string {
  return jwt.sign({ sub: userId, orgId }, env.REFRESH_TOKEN_SECRET, {
    expiresIn: REFRESH_TOKEN_TTL,
    jwtid: randomUUID(),
  });
}

/**
 * A refresh token is a 200+ bit random value, so a fast hash is the right
 * choice — bcrypt exists to slow down guessing of *low*-entropy human
 * passwords and would buy nothing here. Storing the digest means a database
 * dump yields no usable sessions.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** `jwt.verify` returns `string | JwtPayload`; only the object form is ever valid for us. */
function decode(token: string, secret: string, kind: string): JwtPayload {
  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    // Deliberately opaque: expired, malformed and wrong-signature are all
    // "log in again" to the client, and distinguishing them tells an attacker
    // which half of a forgery attempt worked.
    throw new ApiError(401, `Invalid or expired ${kind} token`);
  }

  if (typeof payload === 'string') {
    throw new ApiError(401, `Invalid ${kind} token payload`);
  }
  return payload;
}

export function verifyAccessToken(token: string): AuthUser {
  const payload = decode(token, env.ACCESS_TOKEN_SECRET, 'access');
  const { sub, orgId, role } = payload;

  // A token signed with our key but carrying an unexpected shape is a bug on
  // our side, not a forgery — but it must still not become an `undefined`
  // orgId that silently widens a query's scope.
  if (typeof sub !== 'string' || typeof orgId !== 'string' || !isRole(role)) {
    throw new ApiError(401, 'Malformed access token');
  }
  return { id: sub, orgId, role };
}

export function verifyRefreshToken(token: string): RefreshClaims {
  const payload = decode(token, env.REFRESH_TOKEN_SECRET, 'refresh');
  const { sub, orgId, jti } = payload;

  if (typeof sub !== 'string' || typeof jti !== 'string') {
    throw new ApiError(401, 'Malformed refresh token');
  }
  if (orgId !== null && typeof orgId !== 'string') {
    throw new ApiError(401, 'Malformed refresh token');
  }
  return { userId: sub, orgId: orgId ?? null, jti };
}

/**
 * When the current access token expires, as an ISO string. The client cannot
 * read the httpOnly cookie, so the server states this for the session panel's
 * countdown.
 */
export function accessTokenExpiry(from: Date = new Date()): string {
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
  return new Date(from.getTime() + FIFTEEN_MINUTES_MS).toISOString();
}
