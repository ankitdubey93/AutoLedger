import { Router } from 'express';
import * as productLineController from '../../controllers/unitecon/productLineController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/unitecon/product-lines — see docs/api.md.
 *
 * Reading is open to any member. Create/update are bookkeeping-adjacent
 * configuration, so ACCOUNTANT and above. Delete is OWNER/ADMIN only —
 * removing a product line drops a dimension from every historical PVM
 * report, the same reasoning that makes DELETE /forecaster/plans/:id
 * OWNER/ADMIN.
 */
const router = Router();

router.get('/', authenticate, productLineController.list);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), productLineController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), productLineController.update);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN'), productLineController.remove);

export default router;
