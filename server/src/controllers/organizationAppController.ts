import type { RequestHandler } from 'express';
import * as organizationAppService from '../services/organizationAppService.js';
import { replaceOrganizationAppsSchema } from '../schemas/organizationAppSchema.js';
import { parseBody } from '../utils/parseBody.js';
import { requireUser } from '../utils/requireUser.js';

/**
 * Thin adapters over organizationAppService. Zero SQL (guardrails rule 2).
 * The organization comes from the verified access token only.
 */

/** GET /organizations/apps — every app, flagged enabled or not for the active organization. */
export const list: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const { selectionCompletedAt, apps } = await organizationAppService.getOrganizationApps(user.orgId);
  res.json({ success: true, selectionCompletedAt, count: apps.length, apps });
};

/** PUT /organizations/apps — replace the active organization's enabled-app set. */
export const replace: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(replaceOrganizationAppsSchema, req.body);
  const { selectionCompletedAt, apps } = await organizationAppService.setOrganizationApps(
    user.orgId,
    user.id,
    input.appSlugs,
  );
  res.json({ success: true, selectionCompletedAt, count: apps.length, apps });
};
