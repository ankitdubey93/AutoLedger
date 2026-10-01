import type { RequestHandler } from 'express';
import * as authService from '../services/authService.js';
import { clearAuthCookies, readRefreshCookie, setAuthCookies } from '../utils/cookies.js';
import { requireUser } from '../utils/requireUser.js';
import { requireParam } from '../utils/routeParam.js';
import { parseBody } from '../utils/parseBody.js';
import { createOrganizationSchema } from '../schemas/organizationSchema.js';
import * as invitationService from '../services/invitationService.js';
import { ApiError } from '../utils/apiError.js';
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
 * (guardrails rule 2). Zero SQL.
 *
 * These are also the only handlers that set or clear cookies — the tokens the
 * service returns are transport-level concerns, and keeping `res.cookie` out
 * of the service keeps the service testable without a Response object.
 */


/**
 * POST /auth/register — creates user + organization + OWNER membership, or
 * (Phase 37, with `inviteToken`) user + membership in the inviting organization.
 * Returns 201 without a session; the client logs in immediately after.
 */
export const register: RequestHandler = async (req, res) => {
  const body = requireBodyObject(req.body);

  // Phase 37 — an invite token replaces the organization name: the new user
  // joins the inviting organization instead of creating one.
  const inviteToken = optionalString(body, 'inviteToken', { max: 128 });

  const user = await authService.register({
    name: optionalString(body, 'name', { max: 120 }),
    email: requireEmail(body),
    password: requirePassword(body),
    organizationName: inviteToken === null ? requireString(body, 'organizationName', { min: 2, max: 120 }) : null,
    inviteToken,
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

/**
 * POST /auth/forgot-password — always 202 with the same body, whether or not
 * the email has an account (see authService.requestPasswordReset). Not
 * `requireEmail`: a format error would still be a different answer.
 */
export const forgotPassword: RequestHandler = async (req, res) => {
  const body = requireBodyObject(req.body);
  const email = requireString(body, 'email', { max: 254 });
  await authService.requestPasswordReset(email);
  res.status(202).json({ success: true, message: 'If an account exists for that email, a reset link has been sent.' });
};

/** POST /auth/reset-password — `{ token, password }`; the password obeys the same rules as registration. */
export const resetPassword: RequestHandler = async (req, res) => {
  const body = requireBodyObject(req.body);
  const token = requireString(body, 'token', { max: 128 });
  const password = requirePassword(body);
  await authService.resetPassword(token, password);
  res.json({ success: true });
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

/* ------------------------------------------------------------- Phase 37
 * The routes below move the session to another organization, so they live
 * under /auth for the same reason /switch-org does: the refresh cookie is
 * scoped to `path=/api/v1/auth` and is only sent here. Elsewhere the old
 * refresh row could not be retired and would linger until it expired.
 */

/**
 * POST /auth/organizations — create an organization the caller owns and move
 * the session into it. Not role-gated: the caller's role in the *current*
 * organization says nothing about whether they may start a new one.
 */
export const createOrganization: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { name } = parseBody(createOrganizationSchema, req.body);
  const { accessToken, refreshToken, session } = await authService.createOrganization(
    user.id,
    name,
    readRefreshCookie(req.cookies),
  );
  setAuthCookies(res, accessToken, refreshToken);
  res.status(201).json({ success: true, ...session });
};

/** POST /auth/leave-org — leave the active organization; the session moves to another. */
export const leaveOrganization: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { accessToken, refreshToken, session } = await authService.leaveOrganization(
    user.id,
    user.orgId,
    readRefreshCookie(req.cookies),
  );
  setAuthCookies(res, accessToken, refreshToken);
  res.json({ success: true, ...session });
};

/** GET /auth/invitations/:token — public preview of an invitation link. */
export const previewInvitation: RequestHandler = async (req, res) => {
  const invitation = await invitationService.previewInvitation(requireParam(req, 'token'));
  res.json({ success: true, invitation });
};

/** POST /auth/invitations/:token/accept — join the inviting organization and move the session there. */
export const acceptInvitation: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { accessToken, refreshToken, session } = await authService.acceptInvitation(
    user.id,
    requireParam(req, 'token'),
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
