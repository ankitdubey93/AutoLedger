import { Router } from 'express';
import * as depositController from '../../controllers/accounting/depositController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/deposit-applications — Phase 42. Voiding is split by direction so
 * each route can gate on its own permission before the row is loaded: a sales
 * application needs `invoices.void`, a purchase application `bills.void`.
 * The service refuses an application of the other direction with 404.
 */
const router = Router();

router.post(
  '/sales/:id/void',
  authenticate,
  requirePermission('invoices.void'),
  depositController.voidSales,
);
router.post(
  '/purchase/:id/void',
  authenticate,
  requirePermission('bills.void'),
  depositController.voidPurchase,
);

export default router;
