import type { CookieOptions, Response } from 'express';
import { env } from '../config/env.js';
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_MS,
} from '../config/constants.js';

/**
 * The only module that touches auth cookies.
 *
 * It exists because `res.clearCookie` is not "delete the cookie" — it sets an
 * expired cookie, and the browser only matches it to the existing one if
 * `path`, `domain`, `secure`, `httpOnly` and `sameSite` all agree. Clearing a
 * `path=/api/v1/auth` cookie at `path=/` silently does nothing, and logout
 * appears to work while the session stays alive. Deriving both the set and the
 * clear from the same options objects makes that mismatch impossible.
 *
 * See study/security-auth/cookies-samesite-and-csrf.md.
 */

/**
 * `httpOnly` keeps the token out of `document.cookie`, so an XSS payload
 * cannot read it — the reason tokens live here rather than in localStorage.
 *
 * `sameSite: 'lax'` is sufficient despite the client being on a different
 * port: same-site is computed from the registrable domain plus scheme and
 * **ignores the port**, so :5173 → :5000 is cross-origin but same-site, and
 * Lax cookies are sent on all methods. (The trap: `127.0.0.1` is not in the
 * Public Suffix List, so mixing it with `localhost` genuinely is cross-site
 * and every cookie silently disappears. Keep both on `localhost`.)
 *
 * `secure` is off in development only because there is no TLS on localhost.
 */
const baseOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.isProduction,
};

const accessCookieOptions: CookieOptions = {
  ...baseOptions,
  path: '/',
};

/**
 * Scoped to the auth routes: the refresh token is not attached to ordinary API
 * calls, so it cannot leak into a proxy log or a request dump from any other
 * endpoint. Its lifetime matches the token's own 7 days.
 */
const refreshCookieOptions: CookieOptions = {
  ...baseOptions,
  path: REFRESH_COOKIE_PATH,
  maxAge: REFRESH_TOKEN_TTL_MS,
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, accessCookieOptions);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
}

/**
 * `maxAge` is deliberately omitted here: it is not part of the browser's
 * matching rules, and `clearCookie` supplies its own expiry.
 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, accessCookieOptions);
  res.clearCookie(REFRESH_COOKIE_NAME, { ...baseOptions, path: REFRESH_COOKIE_PATH });
}
