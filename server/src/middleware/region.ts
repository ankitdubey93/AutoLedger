import type { RequestHandler } from 'express';
import type { Region } from '../config/regions.js';
import { getRegion } from '../services/accounting/regionService.js';
import { ApiError } from '../utils/apiError.js';

/**
 * Phase 49a — refuses a route outside the organization's jurisdiction pack.
 * Mount after `requirePermission`. Reads the database per request, as
 * permissions do, so a region change applies on the next request; the region
 * is never read from the token, which could be up to 15 minutes stale.
 */
export function requireRegion(region: Region): RequestHandler {
  return (req, _res, next) => {
    if (req.user === undefined) {
      next(new ApiError(401, 'Authentication required'));
      return;
    }
    getRegion(req.user.orgId)
      .then((actual) => {
        next(actual === region ? undefined : new ApiError(403, 'This feature is not available for this organization\'s country'));
      })
      .catch(next);
  };
}
