import type { RequestHandler } from 'express';
import * as organizationService from '../services/organizationService.js';
import { requireUser } from '../utils/requireUser.js';

/**
 * Thin adapters over organizationService. Zero SQL (guardrails rule 1).
 *
 * Note what these handlers never read: `req.params.orgId`, `req.query.orgId`,
 * or an `X-Org-Id` header. The organization comes from `requireUser(req).orgId`
 * — the verified access token — and nowhere else. There is a test that sends
 * all three of those pointing at another tenant and asserts the response is
 * unchanged.
 */

/** GET /organizations — the caller's active organization. */
export const getActiveOrganization: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const organization = await organizationService.getById(user.orgId);
  res.json({ success: true, organization });
};

/** GET /organizations/members — everyone in the active organization. */
export const listMembers: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const members = await organizationService.listMembers(user.orgId);
  res.json({ success: true, count: members.length, members });
};
