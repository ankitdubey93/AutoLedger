import { Router } from 'express';
import * as budgetController from '../../controllers/forecaster/budgetController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/** /api/v1/forecaster/budget-lines — see docs/api.md. */
const router = Router();

router.patch(
  '/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  budgetController.updateLine,
);
router.delete(
  '/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  budgetController.removeLine,
);

export default router;
