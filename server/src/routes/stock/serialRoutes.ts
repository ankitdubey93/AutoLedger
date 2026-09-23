import { Router } from 'express';
import * as serialController from '../../controllers/stock/serialController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/stock/serials — see docs/api.md.
 *
 * Both a status change and an attribute edit are bookkeeping (they change
 * what a real, in-stock unit is recorded as), so both take ACCOUNTANT or
 * above, matching /stock/items.
 */
const router = Router();

router.post('/:id/status', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), serialController.changeStatus);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), serialController.updateAttributes);

export default router;
