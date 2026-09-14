import type { RequestHandler } from 'express';
import * as autoPostService from '../../services/ap-flow/autoPostService.js';
import { updateApFlowSettingsSchema } from '../../schemas/ap-flow/settingsSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';

/** Thin adapters over autoPostService. Zero SQL (guardrails rule 2). */

/** GET /ap-flow/settings */
export const getSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const settings = await autoPostService.getSettings(user.orgId);
  res.json({ success: true, settings });
};

/** PUT /ap-flow/settings */
export const updateSettings: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateApFlowSettingsSchema, req.body);
  const settings = await autoPostService.updateSettings(user.orgId, user.id, input);
  res.json({ success: true, settings });
};
