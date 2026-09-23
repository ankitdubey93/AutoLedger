import { Router } from 'express';
import * as catalogueController from '../../controllers/stock/catalogueController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/stock/categories — see docs/api.md.
 *
 * Reading is open to any member. Writing is catalogue configuration, so it
 * takes OWNER or ADMIN. There is no DELETE — a category or attribute is
 * retired with `isActive: false` via PATCH.
 */
const router = Router();

router.get('/', authenticate, catalogueController.listCategories);
router.get('/:id', authenticate, catalogueController.getCategory);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN'), catalogueController.createCategory);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN'), catalogueController.updateCategory);

router.post('/:id/attributes', authenticate, requireRole('OWNER', 'ADMIN'), catalogueController.createAttribute);
router.patch(
  '/:id/attributes/:attributeId',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  catalogueController.updateAttribute,
);

export default router;
