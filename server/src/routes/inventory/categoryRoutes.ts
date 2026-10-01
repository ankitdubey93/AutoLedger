import { Router } from 'express';
import * as catalogueController from '../../controllers/inventory/catalogueController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/categories — see docs/api.md.
 *
 * Reading is open to any member. Writing is catalogue configuration, so it
 * takes OWNER or ADMIN. There is no DELETE — a category or attribute is
 * retired with `isActive: false` via PATCH.
 */
const router = Router();

router.get('/', authenticate, requirePermission('inventory.view'), catalogueController.listCategories);
router.get('/:id', authenticate, requirePermission('inventory.view'), catalogueController.getCategory);
router.post('/', authenticate, requirePermission('inventory.configure'), catalogueController.createCategory);
router.patch('/:id', authenticate, requirePermission('inventory.configure'), catalogueController.updateCategory);

router.post('/:id/attributes', authenticate, requirePermission('inventory.configure'), catalogueController.createAttribute);
router.patch(
  '/:id/attributes/:attributeId',
  authenticate,
  requirePermission('inventory.configure'),
  catalogueController.updateAttribute,
);

export default router;
