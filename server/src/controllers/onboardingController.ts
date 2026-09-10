import type { Request, RequestHandler } from 'express';
import * as onboardingService from '../services/onboardingService.js';
import { saveDraftSchema } from '../schemas/onboardingSchema.js';
import { parseBody } from '../utils/parseBody.js';
import { requireUser } from '../utils/requireUser.js';
import { requireParam } from '../utils/routeParam.js';
import { ApiError } from '../utils/apiError.js';
import { isOnboardingSlug, type OnboardingSlug } from '../types/onboarding.js';

/** Thin adapters over onboardingService. Zero SQL (guardrails rule 2). */

function resolveSlug(req: Request): OnboardingSlug {
  const slug = requireParam(req, 'appSlug');
  if (!isOnboardingSlug(slug)) throw new ApiError(404, 'Unknown app');
  return slug;
}

/** GET /onboarding */
export const checklist: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const items = await onboardingService.getChecklist(user.orgId);
  res.json({ success: true, count: items.length, items });
};

/** GET /onboarding/:appSlug */
export const getOne: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const slug = resolveSlug(req);
  const onboarding = await onboardingService.getState(user.orgId, slug);
  res.json({ success: true, onboarding });
};

/** PUT /onboarding/:appSlug/draft */
export const saveDraft: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const slug = resolveSlug(req);
  const input = parseBody(saveDraftSchema, req.body);
  const onboarding = await onboardingService.saveDraft(user.orgId, slug, input);
  res.json({ success: true, onboarding });
};

/** POST /onboarding/:appSlug/skip */
export const skip: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const slug = resolveSlug(req);
  const onboarding = await onboardingService.skip(user.orgId, slug);
  res.json({ success: true, onboarding });
};

/** POST /onboarding/:appSlug/resume */
export const resume: RequestHandler = async (req, res) => {
  const user = requireUser(req);
  const slug = resolveSlug(req);
  const onboarding = await onboardingService.resume(user.orgId, slug);
  res.json({ success: true, onboarding });
};
