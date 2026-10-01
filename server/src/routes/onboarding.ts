import { Router } from 'express';
import * as onboardingController from '../controllers/onboardingController.js';
import { authenticate } from '../middleware/auth.js';
import { allowAnyMember, requirePermission } from '../middleware/rbac.js';

/**
 * /api/v1/onboarding — see docs/api.md.
 *
 * Platform-level, not namespaced under any app: every app that acquires a
 * setup wizard gets skip-and-resume for free, and `app_slug` on the row
 * carries the namespace (guardrails rule 16), mirroring /audit-logs and
 * /webhooks.
 *
 * Reading is open to any member — a VIEWER seeing "setup incomplete" is
 * harmless and useful, matching /reports. Writing (draft, skip, resume) is
 * organization configuration, so it takes OWNER or ADMIN, the same tier as
 * PATCH /organizations and POST /settings/onboarding.
 * ACCOUNTANT gets no write here, deliberately: skipping a setup wizard is
 * not a bookkeeping action.
 */
const router = Router();

router.get('/', authenticate, allowAnyMember, onboardingController.checklist);
router.get('/:module', authenticate, allowAnyMember, onboardingController.getOne);

router.put(
  '/:module/draft',
  authenticate,
  requirePermission('settings.manage'),
  onboardingController.saveDraft,
);

router.post('/:module/skip', authenticate, requirePermission('settings.manage'), onboardingController.skip);
router.post('/:module/resume', authenticate, requirePermission('settings.manage'), onboardingController.resume);

export default router;
