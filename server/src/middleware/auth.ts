import type { RequestHandler } from 'express';
import { ACCESS_COOKIE_NAME } from '../config/constants.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { ApiError } from '../utils/apiError.js';
import { getRequestContext } from '../utils/requestContext.js';

/**
 * Resolves the caller and their active organization from the access token.
 *
 * Deliberately does **no** database work. The signature proves we issued the
 * token and that nobody altered it, which is enough for its 15-minute life;
 * hitting the database on every request would make the token pointless and put
 * a query in front of every route.
 *
 * The cost of that choice: a membership revoked mid-token stays effective for
 * up to 15 minutes. That is the trade the short TTL buys, and it is documented
 * in docs/architecture.md rather than left as a surprise.
 *
 * `req.user.orgId` set here is the ONLY source of the active organization
 * anywhere in the codebase (guardrails rule 1). A header, query param or body
 * field would be trivially forgeable.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  // `cookies` is populated by cookie-parser in app.ts. Optional-chained so a
  // misordered mount surfaces as a clean 401 rather than a TypeError.
  const token: unknown = req.cookies?.[ACCESS_COOKIE_NAME];

  if (typeof token !== 'string' || token === '') {
    next(new ApiError(401, 'Authentication required'));
    return;
  }

  try {
    req.user = verifyAccessToken(token);

    // Fills in the identity on the already-open request context (see
    // middleware/requestContext.ts) so Phase 5's audit trail can attribute
    // any database write this request goes on to make. This is a copy of
    // the token's claims, never a second source of truth — org_id still
    // comes only from the verified token itself (guardrails rule 1).
    const context = getRequestContext();
    if (context !== undefined) {
      context.userId = req.user.id;
      context.orgId = req.user.orgId;
    }

    next();
  } catch (err) {
    // verifyAccessToken throws ApiError(401) already; pass anything else along
    // untouched so the error handler can decide.
    next(err);
  }
};
