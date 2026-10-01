import { Router } from 'express';
import * as itemController from '../../controllers/accounting/itemController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/items — see docs/api.md.
 *
 * Reading is open to any member, matching /accounts and /customers. Writing
 * is bookkeeping, so it takes ACCOUNTANT or above.
 *
 * There is no DELETE — an item is retired with `isActive: false` via PATCH,
 * matching accounts, customers and vendors.
 */
const router = Router();

router.get('/', authenticate, requirePermission('products.view'), itemController.list);
router.get('/:id', authenticate, requirePermission('products.view'), itemController.getOne);

router.post('/', authenticate, requirePermission('products.manage'), itemController.create);
router.patch('/:id', authenticate, requirePermission('products.manage'), itemController.update);

export default router;
