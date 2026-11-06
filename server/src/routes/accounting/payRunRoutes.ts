import { Router } from 'express';
import * as payRunController from '../../controllers/accounting/payRunController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { requireRegion } from '../../middleware/region.js';

/**
 * /api/v1/pay-runs — Phase 49g. Changing where money goes, and producing the
 * file that sends it, take the same deliberately senior permission.
 */
const router = Router();

const au = requireRegion('AU');
const pay = requirePermission('payments.export_aba');

router.get('/bank-accounts/:accountId', authenticate, pay, au, payRunController.getBankAccount);
router.put('/bank-accounts/:accountId', authenticate, pay, au, payRunController.saveBankAccount);
router.get('/vendor-details', authenticate, pay, au, payRunController.listVendors);
router.put('/vendor-details/:vendorId', authenticate, pay, au, payRunController.saveVendor);
router.get('/', authenticate, pay, au, payRunController.list);
router.post('/', authenticate, pay, au, payRunController.create);
router.get('/:id/aba', authenticate, pay, au, payRunController.aba);

export default router;
