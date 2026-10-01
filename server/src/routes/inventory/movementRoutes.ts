import { Router } from 'express';
import * as movementController from '../../controllers/inventory/movementController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/receipts, /issues, /transfers, /adjustments, /balances,
 * /movements, /items/:id/lots, /items/:id/serials, /summary — see docs/api.md.
 *
 * Posting a movement is bookkeeping (creating and adjusting stock), so it
 * takes ACCOUNTANT or above, matching /stock/items. Reading is open to any
 * member.
 *
 * `/items/:id/lots` and `/items/:id/serials` live here, not in
 * itemRoutes.ts — `routes/inventory/index.ts` mounts this router BEFORE
 * itemRoutes so `/items/:id` there can never shadow these two.
 */
const router = Router();

router.post('/receipts', authenticate, requirePermission('inventory.operate'), movementController.receive);
router.post('/issues', authenticate, requirePermission('inventory.operate'), movementController.issue);
router.post('/transfers', authenticate, requirePermission('inventory.operate'), movementController.transfer);
router.post('/adjustments', authenticate, requirePermission('inventory.operate'), movementController.adjust);

router.get('/balances', authenticate, requirePermission('inventory.view'), movementController.balances);
router.get('/movements', authenticate, requirePermission('inventory.view'), movementController.movements);
router.get('/items/:id/lots', authenticate, requirePermission('inventory.view'), movementController.itemLots);
router.get('/items/:id/serials', authenticate, requirePermission('inventory.view'), movementController.itemSerials);
router.get('/summary', authenticate, requirePermission('inventory.view'), movementController.summary);
router.get('/product-balances', authenticate, requirePermission('inventory.view'), movementController.productBalances);

export default router;
