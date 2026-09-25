import { Router } from 'express';
import * as onboardingController from '../controllers/onboardingController.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

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

router.get('/', authenticate, onboardingController.checklist);
router.get('/:module', authenticate, onboardingController.getOne);

router.put(
  '/:module/draft',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  onboardingController.saveDraft,
);

router.post('/:module/skip', authenticate, requireRole('OWNER', 'ADMIN'), onboardingController.skip);
router.post('/:module/resume', authenticate, requireRole('OWNER', 'ADMIN'), onboardingController.resume);

export default router;
