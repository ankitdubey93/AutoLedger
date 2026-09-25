import { Router } from 'express';
import * as movementController from '../../controllers/inventory/movementController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

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

router.post('/receipts', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), movementController.receive);
router.post('/issues', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), movementController.issue);
router.post('/transfers', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), movementController.transfer);
router.post('/adjustments', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), movementController.adjust);

router.get('/balances', authenticate, movementController.balances);
router.get('/movements', authenticate, movementController.movements);
router.get('/items/:id/lots', authenticate, movementController.itemLots);
router.get('/items/:id/serials', authenticate, movementController.itemSerials);
router.get('/summary', authenticate, movementController.summary);
router.get('/product-balances', authenticate, movementController.productBalances);

export default router;
