import { Router } from 'express';
import * as valuationController from '../../controllers/inventory/valuationController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/valuation — read-only report of inventory accounts tying
 * to the general ledger.
 *
 * /api/v1/inventory/reconcile/true-up — post an adjustment journal to bring
 * the GL into line with the stock subledger.
 *
 * /api/v1/inventory/reconcile/reclass — sweep linked items' value onto their
 * current configured accounts.
 *
 * /api/v1/inventory/items/link-all — link every unlinked stock item to a
 * ledger item all at once.
 *
 * Reporting is open to any member. Reconciliation edits require ACCOUNTANT
 * or above.
 */
const router = Router();

router.get('/valuation', authenticate, requirePermission('inventory.view'), valuationController.get);
router.post('/reconcile/true-up', authenticate, requirePermission('inventory.operate'), valuationController.trueUp);
router.post('/reconcile/reclass', authenticate, requirePermission('inventory.operate'), valuationController.reclass);
router.post('/items/link-all', authenticate, requirePermission('inventory.operate'), valuationController.linkAll);

export default router;
