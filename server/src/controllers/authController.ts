import type { RequestHandler } from 'express';
import * as authService from '../services/authService.js';
import { clearAuthCookies, setAuthCookies } from '../utils/cookies.js';
import { requireUser } from '../utils/requireUser.js';
import { ApiError } from '../utils/apiError.js';
import { REFRESH_COOKIE_NAME } from '../config/constants.js';
import {
  optionalString,
  requireBodyObject,
  requireEmail,
  requirePassword,
  requireString,
  requireUuid,
} from '../utils/validate.js';

/**
 * Thin HTTP adapters: read input, call the service, shape the response
 * (guardrails rule 1). Zero SQL.
 *
 * These are also the only handlers that set or clear cookies — the tokens the
 * service returns are transport-level concerns, and keeping `res.cookie` out
 * of the service keeps the service testable without a Response object.
 */

/** Reads the refresh cookie, which is absent for a first-time or logged-out caller. */
function readRefreshCookie(cookies: unknown): string | null {
  if (typeof cookies !== 'object' || cookies === null) return null;
  const value = (cookies as Record<string, unknown>)[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * POST /auth/register — creates user + organization + OWNER membership.
 * Returns 201 without a session; the client logs in immediately after.
 */
export const register: RequestHandler = async (req, res) => {
  const body = requireBodyObject(req.body);

  const user = await authService.register({
    name: optionalString(body, 'name', { max: 120 }),
    email: requireEmail(body),
    password: requirePassword(body),
    organizationName: requireString(body, 'organizationName', { min: 2, max: 120 }),
  });

  res.status(201).json({ success: true, user });
};

/** POST /auth/login — sets both cookies. */
export const login: RequestHandler = async (req, res) => {
  const body = requireBodyObject(req.body);

  // Not requireEmail(): a validation error here would tell the caller their
  // email is malformed rather than simply wrong, and login should reveal
  // nothing. Any non-matching string falls through to the same 401.
  const email = requireString(body, 'email', { max: 254 });
  const password = requireString(body, 'password', { max: 512 });

  const { accessToken, refreshToken, session } = await authService.login(email, password);
  setAuthCookies(res, accessToken, refreshToken);
  res.json({ success: true, ...session });
};

/** GET /auth/check — requires `authenticate`. */
export const check: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const session = await authService.getSession(user.id, user.orgId);
  res.json({ success: true, ...session });
};

/**
 * POST /auth/refresh — rotates both tokens.
 *
 * POST, not GET, even though it reads like one. Rotation is state-changing,
 * and SameSite=Lax deliberately still sends cookies on a top-level cross-site
 * *navigation* — so as a GET, a plain link from any site would silently rotate
 * a visitor's session and log them out.
 */
export const refresh: RequestHandler = async (req, res) => {
  const token = readRefreshCookie(req.cookies);
  if (token === null) throw new ApiError(401, 'No refresh token');

  try {
    const { accessToken, refreshToken, session } = await authService.rotateRefreshToken(token);
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ success: true, ...session });
  } catch (err) {
    // The token is spent or invalid either way, so clear the cookies rather
    // than leaving the browser to keep replaying a dead credential.
    clearAuthCookies(res);
    throw err;
  }
};

/** POST /auth/switch-org — re-issues the session against another organization. */
export const switchOrg: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const body = requireBodyObject(req.body);
  const orgId = requireUuid(body, 'orgId');

  const { accessToken, refreshToken, session } = await authService.switchOrg(
    user.id,
    orgId,
    readRefreshCookie(req.cookies),
  );

  setAuthCookies(res, accessToken, refreshToken);
  res.json({ success: true, ...session });
};

/** POST /auth/logout — always succeeds, so the client can always reach a clean state. */
export const logout: RequestHandler = async (req, res) => {
  await authService.logout(readRefreshCookie(req.cookies));
  clearAuthCookies(res);
  res.json({ success: true });
};
