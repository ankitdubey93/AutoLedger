import type { RequestHandler } from 'express';
import * as organizationProfileService from '../services/organizationProfileService.js';
import { updateOrganizationProfileSchema } from '../schemas/organizationProfileSchema.js';
import { parseBody } from '../utils/parseBody.js';
import { requireUser } from '../utils/requireUser.js';

/**
 * Thin adapters over organizationProfileService. Zero SQL (guardrails rule 2).
 *
 * Note what these handlers never read: `req.params.orgId`, `req.query.orgId`,
 * or an `X-Org-Id` header. The organization comes from `requireUser(req).orgId`
 * — the verified access token — and nowhere else. There is a test that sends
 * all three of those pointing at another tenant and asserts the response is
 * unchanged.
 */

/** GET /organizations/profile */
export const get: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const profile = await organizationProfileService.getProfile(user.orgId);
  res.json({ success: true, profile });
};

/** PATCH /organizations/profile */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateOrganizationProfileSchema, req.body);
  const profile = await organizationProfileService.updateProfile(user.orgId, input);
  res.json({ success: true, profile });
};
