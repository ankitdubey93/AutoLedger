import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../utils/apiError.js';

/** Methods that must not change state, so a forged one can do no harm. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** FRONTEND_URL reduced to an origin (scheme://host:port), so a trailing slash or path never causes a mismatch. */
const TRUSTED_ORIGIN = new URL(env.FRONTEND_URL).origin;

/**
 * CSRF defence in depth for the cookie-authenticated API (2026-09-29).
 *
 * The session lives in cookies, and a browser attaches cookies to a request
 * whoever triggers it. `SameSite=Lax` already withholds them from cross-site
 * POSTs; this check adds a second, independent layer. A browser always sends
 * `Origin` on a cross-origin request and on any `fetch` POST, and a page on
 * another origin cannot forge it. So a state-changing request whose `Origin`
 * is present and is not the app's own is refused — including `Origin: null`,
 * which sandboxed iframes and some redirects send.
 *
 * A request with **no** `Origin` is allowed: that is a non-browser caller
 * (curl, a server-to-server integration, the test suite, the demo seeder),
 * which holds no victim's cookies to abuse. CORS does not cover this case:
 * it stops a hostile page *reading* the response, not the request from
 * reaching the handler and taking effect.
 */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  if (origin !== undefined && origin !== TRUSTED_ORIGIN) {
    next(new ApiError(403, 'Cross-origin request refused'));
    return;
  }
  next();
};
