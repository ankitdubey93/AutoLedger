import { Router } from 'express';
import * as settingsController from '../../controllers/accounting/settingsController.js';
import * as invoiceSettingsController from '../../controllers/accounting/invoiceSettingsController.js';
import { authenticate } from '../../middleware/auth.js';
import { allowAnyMember, requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/settings — see docs/api.md.
 *
 * Reading is open to any member, matching /reports — a VIEWER reading a report
 * needs to know the fiscal year it covers. Writing is organization
 * configuration, so it takes OWNER or ADMIN, matching /organizations/members —
 * deliberately NOT the ACCOUNTANT-inclusive bookkeeping tier used by accounts
 * and journals.
 */
const router = Router();

router.get('/', authenticate, allowAnyMember, settingsController.get);

router.post(
  '/onboarding',
  authenticate,
  requirePermission('settings.manage'),
  settingsController.onboard,
);

router.patch('/', authenticate, requirePermission('settings.manage'), settingsController.update);

router.get('/invoicing', authenticate, allowAnyMember, invoiceSettingsController.get);
router.patch('/invoicing', authenticate, requirePermission('settings.manage'), invoiceSettingsController.update);

export default router;
