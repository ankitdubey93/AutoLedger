import type { Request, RequestHandler } from 'express';
import { ApiError } from '../utils/apiError.js';
import type { Role } from '../types/auth.js';
import { pool } from '../db/connect.js';
import { PERMISSIONS, type Permission } from '../config/permissions.js';
import { resolveMemberAccess, type MemberAccess } from '../services/permissionService.js';

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

/* ------------------------------------------------------------- Phase 38c */

/**
 * Marks a handler as the route's access decision, so the route-coverage
 * test (`__tests__/platform/routePermissions.test.ts`) can prove every
 * authenticated route has one.
 */
export interface AccessDecision {
  accessDecision: { kind: 'permission'; key: Permission } | { kind: 'any-member' };
}

const LABELS = new Map(PERMISSIONS.map((p) => [p.key, p.label]));

/**
 * The caller's membership and permissions in the active organization, from
 * the database (`permissionService.resolveMemberAccess`), memoised on the
 * request. A member removed since their token was issued gets 403 here at
 * once, rather than at their next refresh.
 */
export async function loadAccess(req: Request): Promise<MemberAccess> {
  if (req.access !== undefined) return req.access;
  if (req.user === undefined) throw new ApiError(401, 'Authentication required');
  const access = await resolveMemberAccess(pool, req.user.orgId, req.user.id);
  if (access === null) throw new ApiError(403, 'You are no longer a member of this organization');
  req.access = access;
  return access;
}

/**
 * Phase 38c — the route-level permission gate that replaces `requireRole`.
 * Mount after `authenticate`.
 *
 *   router.post('/:id/issue', authenticate, requirePermission('invoices.issue'), issue);
 *
 * Checks the caller's CURRENT permissions (one indexed query per request),
 * so a custom-role edit or a member change takes effect on the next
 * request, not after the 15-minute access token expires.
 */
export function requirePermission(key: Permission): RequestHandler & AccessDecision {
  const handler: RequestHandler = (req, _res, next) => {
    loadAccess(req)
      .then((access) => {
        if (!access.permissions.has(key)) {
          next(new ApiError(403, `This action needs the "${LABELS.get(key) ?? key}" permission.`));
          return;
        }
        next();
      })
      .catch(next);
  };
  return Object.assign(handler, { accessDecision: { kind: 'permission' as const, key } });
}

/**
 * Phase 38c — an explicit "any member of the organization may call this"
 * marker, for reads the app shell needs whatever the role (the current
 * organization, its ledger settings, onboarding state). It still verifies
 * current membership, so a removed member is refused at once.
 */
export const allowAnyMember: RequestHandler & AccessDecision = Object.assign(
  ((req, _res, next) => {
    loadAccess(req)
      .then(() => next())
      .catch(next);
  }) as RequestHandler,
  { accessDecision: { kind: 'any-member' as const } },
);
