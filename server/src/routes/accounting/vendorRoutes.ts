import { Router } from 'express';
import * as vendorController from '../../controllers/accounting/vendorController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/vendors — see docs/api.md.
 *
 * Reading is open to any member, matching /customers. Writing is bookkeeping,
 * so it takes ACCOUNTANT or above, matching customers and accounts.
 *
 * There is no DELETE — a vendor is retired with `isActive: false` via PATCH,
 * matching customers.
 */
const router = Router();

router.get('/', authenticate, requirePermission('vendors.view'), vendorController.list);
router.get('/:id', authenticate, requirePermission('vendors.view'), vendorController.getOne);
router.get('/:id/ledger', authenticate, requirePermission('vendors.view'), vendorController.ledger);
router.get('/:id/open-items', authenticate, requirePermission('vendors.view'), vendorController.openItems);

router.post('/', authenticate, requirePermission('vendors.manage'), vendorController.create);
router.patch('/:id', authenticate, requirePermission('vendors.manage'), vendorController.update);

export default router;
