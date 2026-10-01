import { Router } from 'express';
import * as serialController from '../../controllers/inventory/serialController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/serials — see docs/api.md.
 *
 * Both a status change and an attribute edit are bookkeeping (they change
 * what a real, in-stock unit is recorded as), so both take ACCOUNTANT or
 * above, matching /stock/items.
 */
const router = Router();

router.post('/:id/status', authenticate, requirePermission('inventory.operate'), serialController.changeStatus);
router.patch('/:id', authenticate, requirePermission('inventory.operate'), serialController.updateAttributes);

export default router;
