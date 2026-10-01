import { Router } from 'express';
import * as itemController from '../../controllers/inventory/itemController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/items — see docs/api.md.
 *
 * Reading is open to any member, matching /ledger-core/items. Writing is
 * bookkeeping (creating and adjusting the item master), so it takes
 * ACCOUNTANT or above. There is no DELETE — an item is retired with
 * `isActive: false` via PATCH.
 */
const router = Router();

router.get('/', authenticate, requirePermission('inventory.view'), itemController.list);
router.get('/:id', authenticate, requirePermission('inventory.view'), itemController.getOne);

router.post('/', authenticate, requirePermission('inventory.operate'), itemController.create);
router.post(
  '/from-product/:productId',
  authenticate,
  requirePermission('inventory.operate'),
  itemController.createFromProduct,
);
router.patch('/:id', authenticate, requirePermission('inventory.operate'), itemController.update);
router.post('/:id/link-product', authenticate, requirePermission('inventory.operate'), itemController.linkProduct);

export default router;
