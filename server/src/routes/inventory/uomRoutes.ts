import { Router } from 'express';
import * as catalogueController from '../../controllers/inventory/catalogueController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/uoms — see docs/api.md.
 *
 * Reading is open to any member. Writing is catalogue configuration, so it
 * takes OWNER or ADMIN, mirroring /unitecon/settings. There is no DELETE —
 * a unit of measure is retired with `isActive: false` via PATCH.
 */
const router = Router();

router.get('/', authenticate, requirePermission('inventory.view'), catalogueController.listUoms);
router.post('/', authenticate, requirePermission('inventory.configure'), catalogueController.createUom);
router.patch('/:id', authenticate, requirePermission('inventory.configure'), catalogueController.updateUom);

export default router;
