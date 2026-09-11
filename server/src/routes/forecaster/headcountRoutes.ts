import { Router } from 'express';
import * as headcountController from '../../controllers/forecaster/headcountController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/forecaster/headcount — see docs/api.md.
 *
 * Read is open to every member including VIEWER. Every mutation needs
 * ACCOUNTANT and above.
 */
const router = Router();

router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), headcountController.update);
router.delete(
  '/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  headcountController.remove,
);

export default router;
