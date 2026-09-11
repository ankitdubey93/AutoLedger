import { Router } from 'express';
import * as forecastController from '../../controllers/forecaster/forecastController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/forecaster/forecast-lines — see docs/api.md.
 *
 * Read is open to every member including VIEWER. Every mutation needs
 * ACCOUNTANT and above.
 */
const router = Router();

router.patch(
  '/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  forecastController.updateLine,
);
router.delete(
  '/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  forecastController.removeLine,
);

export default router;
