import type { RequestHandler } from 'express';
import * as settingsService from '../../services/accounting/settingsService.js';
import { onboardingSchema, updateSettingsSchema } from '../../schemas/accounting/settingsSchema.js';
import * as regionService from '../../services/accounting/regionService.js';
import { activateAustraliaSchema, updateGstSettingsSchema } from '../../schemas/accounting/regionSchema.js';
import { parseBody } from '../../utils/parseBody.js';
import { requireUser } from '../../utils/requireUser.js';

/**
 * Thin adapters over settingsService. Zero SQL (guardrails rule 2).
 *
 * The organization comes from `requireUser(req).orgId` — the verified access
 * token — and never from a param, query value or header (rule 1).
 */

/** GET /settings */
export const get: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const settings = await settingsService.getSettings(user.orgId);
  res.json({ success: true, settings });
};

/** POST /settings/onboarding — idempotent; re-submitting overwrites, never 409s. */
export const onboard: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(onboardingSchema, req.body);
  const settings = await settingsService.completeOnboarding(user.orgId, input);
  res.json({ success: true, settings });
};

/** PATCH /settings */
export const update: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateSettingsSchema, req.body);
  const settings = await settingsService.updateSettings(user.orgId, user.id, input);
  res.json({ success: true, settings });
};

/** POST /settings/region/australia */
export const activateAustralia: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(activateAustraliaSchema, req.body);
  await regionService.activateAustralia(user.orgId, input.gst, input.timezone);
  res.json({ success: true, settings: await settingsService.getSettings(user.orgId) });
};

/** POST /settings/region/generic */
export const deactivateAustralia: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  await regionService.deactivateAustralia(user.orgId);
  res.json({ success: true, settings: await settingsService.getSettings(user.orgId) });
};

/** PATCH /settings/gst */
export const updateGst: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const input = parseBody(updateGstSettingsSchema, req.body);
  await regionService.updateGstSettings(user.orgId, {
    ...(input.registered !== undefined ? { registered: input.registered } : {}),
    ...(input.basis !== undefined ? { basis: input.basis } : {}),
    ...(input.basCycle !== undefined ? { basCycle: input.basCycle } : {}),
    ...(input.basMethod !== undefined ? { basMethod: input.basMethod } : {}),
    ...(input.timezone !== undefined ? { timeZone: input.timezone } : {}),
  });
  res.json({ success: true, settings: await settingsService.getSettings(user.orgId) });
};
