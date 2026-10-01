import { Router } from 'express';
import * as customerController from '../../controllers/accounting/customerController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/customers — see docs/api.md.
 *
 * Reading is open to any member, matching /accounts. Writing is bookkeeping,
 * so it takes ACCOUNTANT or above, matching accounts and journals.
 *
 * There is no DELETE — a customer is retired with `isActive: false` via
 * PATCH, matching accounts.
 */
const router = Router();

router.get('/', authenticate, requirePermission('customers.view'), customerController.list);
router.get('/:id', authenticate, requirePermission('customers.view'), customerController.getOne);
router.get('/:id/ledger', authenticate, requirePermission('customers.view'), customerController.ledger);
router.get('/:id/open-items', authenticate, requirePermission('customers.view'), customerController.openItems);

router.post('/', authenticate, requirePermission('customers.manage'), customerController.create);
router.patch('/:id', authenticate, requirePermission('customers.manage'), customerController.update);

export default router;
