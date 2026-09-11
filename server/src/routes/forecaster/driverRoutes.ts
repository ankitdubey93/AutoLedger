import { Router } from 'express';
import * as driverController from '../../controllers/forecaster/driverController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/forecaster/drivers — see docs/api.md.
 *
 * Read is open to every member including VIEWER. Every mutation needs
 * ACCOUNTANT and above.
 */
const router = Router();

router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), driverController.update);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), driverController.remove);
router.get('/:id/values', authenticate, driverController.listValues);
router.put(
  '/:id/values',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  driverController.setValues,
);

export default router;
