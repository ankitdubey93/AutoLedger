import type { RequestHandler } from 'express';
import * as setupService from '../../services/stock/setupService.js';
import { applyProfileSchema } from '../../schemas/stock/setupSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';

/** Thin adapters over setupService. Zero SQL (guardrails rule 2). */

/** GET /stock/settings */
export const getSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const settings = await setupService.getStockSettings(user.orgId);
  res.json({ success: true, settings });
};

/** GET /stock/setup/profiles */
export const listProfiles: RequestHandler = (_req, res) => {
  const profiles = setupService.listProfiles();
  res.json({ success: true, count: profiles.length, profiles });
};

/** POST /stock/setup */
export const apply: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(applyProfileSchema, req.body);
  const result = await setupService.applyIndustryProfile(user.orgId, user.id, input.industryProfile);
  res.json({ success: true, settings: result.settings, created: result.created });
};
