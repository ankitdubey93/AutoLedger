import { Router } from 'express';
import * as budgetController from '../../controllers/forecaster/budgetController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/forecaster/budget-versions — see docs/api.md.
 *
 * Read is open to every member including VIEWER. Creating, compiling and
 * editing lines needs ACCOUNTANT and above. Approving a version needs
 * OWNER/ADMIN only — it is a financial decision of record.
 */
const router = Router();

router.get('/:id', authenticate, budgetController.getVersion);
router.delete(
  '/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  budgetController.removeVersion,
);
router.post(
  '/:id/compile',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  budgetController.compileVersion,
);
router.post('/:id/approve', authenticate, requireRole('OWNER', 'ADMIN'), budgetController.approveVersion);
router.post(
  '/:id/lines',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  budgetController.addLine,
);

export default router;
