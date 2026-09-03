import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { ApiError } from '../utils/apiError.js';
import { AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS } from '../config/constants.js';

/**
 * Throttles credential endpoints — carried debt from Phase 1, scheduled for
 * Phase 3 by docs/development.md.
 *
 * Applied to `/auth/login` and `/auth/register` only. Deliberately **not** to
 * `/auth/refresh`: a legitimate client rotates its token on a schedule and on
 * every 401 retry, so throttling it would log active users out. Nor to
 * `/auth/logout`, where the failure mode is a user unable to clear their own
 * session.
 */

/**
 * Builds the limiter. Parameterised so a test can assert the 429 path with a
 * small limit without lowering it for every other test in the suite.
 */
export function createAuthLimiter(
  options: { windowMs?: number; max?: number } = {},
): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? AUTH_RATE_LIMIT_WINDOW_MS,
    limit: options.max ?? AUTH_RATE_LIMIT_MAX,

    // Standard `RateLimit-*` headers; the deprecated `X-RateLimit-*` set is off.
    standardHeaders: 'draft-7',
    legacyHeaders: false,

    // Count only failures. A successful login should not consume a user's
    // budget, or a shared office NAT would lock out colleagues in turn.
    skipSuccessfulRequests: true,

    /**
     * Route the rejection through `errorHandler` rather than letting the
     * library write its own body. Every error response in this API is
     * `{ success: false, error }` (docs/api.md), and a middleware emitting a
     * different shape is exactly the kind of inconsistency a client discovers
     * in production.
     */
    handler: (_req, _res, next) => {
      next(new ApiError(429, 'Too many attempts. Try again later.'));
    },
  });
}

export const authLimiter: RequestHandler = createAuthLimiter();
