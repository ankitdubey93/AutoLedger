import type { RequestHandler } from 'express';
import { ApiError } from '../utils/apiError.js';
import type { Role } from '../types/auth.js';

/**
 * Route-level role gate. Mount after `authenticate`, which is what puts the
 * role on `req.user`.
 *
 *   router.get('/members', authenticate, requireRole('OWNER', 'ADMIN'), listMembers);
 *
 * The role checked is the caller's role *in their active organization*, not a
 * global one — permissions are per organization (docs/architecture.md).
 *
 * This is plain RBAC: permission depends only on the role name. It stays that
 * way until a module genuinely needs per-resource rules; building a permission
 * engine before there are permissions to manage is how you end up maintaining
 * one nobody uses.
 */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    // 401 vs 403 is a real distinction: "we don't know who you are" is
    // recoverable by logging in, "you may not do this" is not.
    if (req.user === undefined) {
      next(new ApiError(401, 'Authentication required'));
      return;
    }

    if (!allowed.includes(req.user.role)) {
      next(
        new ApiError(
          403,
          `This action requires one of: ${allowed.join(', ')}. Your role is ${req.user.role}.`,
        ),
      );
      return;
    }

    next();
  };
}
