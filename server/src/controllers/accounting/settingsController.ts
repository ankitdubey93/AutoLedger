import type { RequestHandler } from 'express';
import * as settingsService from '../../services/accounting/settingsService.js';
import { onboardingSchema, updateSettingsSchema } from '../../schemas/accounting/settingsSchema.js';
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
  const settings = await settingsService.updateSettings(user.orgId, input);
  res.json({ success: true, settings });
};
