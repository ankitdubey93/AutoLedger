import type { RequestHandler } from 'express';
import * as settingsService from '../../services/unitecon/settingsService.js';
import { updateSettingsSchema } from '../../schemas/unitecon/settingsSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';

/** Thin adapters over settingsService. Zero SQL (guardrails rule 2). */

/** GET /unitecon/settings */
export const get: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const settings = await settingsService.getSettings(user.orgId);
  res.json({ success: true, settings });
};

/** PATCH /unitecon/settings */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateSettingsSchema, req.body);
  const settings = await settingsService.updateSettings(user.orgId, user.id, input);
  res.json({ success: true, settings });
};
