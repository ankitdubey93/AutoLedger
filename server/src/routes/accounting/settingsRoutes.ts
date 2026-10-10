import { Router } from 'express';
import * as settingsController from '../../controllers/accounting/settingsController.js';
import * as invoiceSettingsController from '../../controllers/accounting/invoiceSettingsController.js';
import * as statementController from '../../controllers/accounting/statementController.js';
import * as statementEmailController from '../../controllers/accounting/statementEmailController.js';
import * as onlinePaymentController from '../../controllers/accounting/onlinePaymentController.js';
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

router.get('/statements', authenticate, allowAnyMember, statementController.getSettings);
router.patch('/statements', authenticate, requirePermission('settings.manage'), statementController.updateSettings);

// Phase 39b — statement email templates. Reading them is part of sending a statement.
router.get('/statement-email-templates', authenticate, requirePermission('statements.send'), statementEmailController.listTemplates);
router.post('/statement-email-templates', authenticate, requirePermission('settings.manage'), statementEmailController.createTemplate);
router.patch('/statement-email-templates/:id', authenticate, requirePermission('settings.manage'), statementEmailController.updateTemplate);
router.delete('/statement-email-templates/:id', authenticate, requirePermission('settings.manage'), statementEmailController.deleteTemplate);

// Phase 39c — online payment of statements.
router.get('/online-payments', authenticate, allowAnyMember, onlinePaymentController.getSettings);
router.patch('/online-payments', authenticate, requirePermission('settings.manage'), onlinePaymentController.updateSettings);

export default router;
