import { Router } from 'express';
import * as settingsController from '../../controllers/ledger-core/settingsController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/settings — see docs/api.md.
 *
 * Reading is open to any member, matching /reports — a VIEWER reading a report
 * needs to know the fiscal year it covers. Writing is organization
 * configuration, so it takes OWNER or ADMIN, matching /organizations/members —
 * deliberately NOT the ACCOUNTANT-inclusive bookkeeping tier used by accounts
 * and journals.
 */
const router = Router();

router.get('/', authenticate, settingsController.get);

router.post(
  '/onboarding',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  settingsController.onboard,
);

router.patch('/', authenticate, requireRole('OWNER', 'ADMIN'), settingsController.update);

export default router;
