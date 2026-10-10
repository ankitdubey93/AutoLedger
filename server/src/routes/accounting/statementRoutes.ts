import { Router } from 'express';
import * as statementController from '../../controllers/accounting/statementController.js';
import * as statementEmailController from '../../controllers/accounting/statementEmailController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/statements — customer & vendor statements (Phase 39) — see docs/api.md.
 *
 * A statement is the party's account in printable form, so reading one takes
 * the same permission as reading the party's ledger.
 */
const router = Router();

// Literal paths before `/:id` (Phase 39b — emailing).
router.post('/customers/send', authenticate, requirePermission('statements.send'), statementEmailController.sendCustomers);
router.post('/vendors/send', authenticate, requirePermission('statements.send'), statementEmailController.sendVendors);
router.post('/customers/preview-email', authenticate, requirePermission('statements.send'), statementEmailController.previewCustomer);
router.post('/vendors/preview-email', authenticate, requirePermission('statements.send'), statementEmailController.previewVendor);
router.get('/customers/:id/sends', authenticate, requirePermission('customers.view'), statementEmailController.customerSends);
router.get('/vendors/:id/sends', authenticate, requirePermission('vendors.view'), statementEmailController.vendorSends);

router.get('/customers', authenticate, requirePermission('customers.view'), statementController.listCustomers);
router.get('/customers/:id', authenticate, requirePermission('customers.view'), statementController.getCustomer);
router.get('/vendors', authenticate, requirePermission('vendors.view'), statementController.listVendors);
router.get('/vendors/:id', authenticate, requirePermission('vendors.view'), statementController.getVendor);

export default router;
