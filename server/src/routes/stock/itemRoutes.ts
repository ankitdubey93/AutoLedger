import { Router } from 'express';
import * as itemController from '../../controllers/stock/itemController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/stock/items — see docs/api.md.
 *
 * Reading is open to any member, matching /ledger-core/items. Writing is
 * bookkeeping (creating and adjusting the item master), so it takes
 * ACCOUNTANT or above. There is no DELETE — an item is retired with
 * `isActive: false` via PATCH.
 */
const router = Router();

router.get('/', authenticate, itemController.list);
router.get('/:id', authenticate, itemController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), itemController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), itemController.update);

export default router;
