import { Router } from 'express';
import * as planController from '../../controllers/forecaster/planController.js';
import * as driverController from '../../controllers/forecaster/driverController.js';
import * as headcountController from '../../controllers/forecaster/headcountController.js';
import * as forecastController from '../../controllers/forecaster/forecastController.js';
import * as budgetController from '../../controllers/forecaster/budgetController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/forecaster/plans — see docs/api.md.
 *
 * Read is open to every member including VIEWER. Creating or editing a plan
 * needs ACCOUNTANT and above — forecasting is accountant work. Deleting a
 * plan needs OWNER/ADMIN only, because it cascades away every driver,
 * headcount role, forecast line and budget version on it.
 */
const router = Router();

router.get('/', authenticate, planController.list);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), planController.create);
router.get('/:id', authenticate, planController.getOne);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), planController.update);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN'), planController.remove);
router.post('/:id/roll', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), planController.roll);

router.get('/:id/drivers', authenticate, driverController.list);
router.post(
  '/:id/drivers',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  driverController.create,
);

router.get('/:id/headcount', authenticate, headcountController.list);
router.post(
  '/:id/headcount',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  headcountController.create,
);

router.get('/:id/forecast-lines', authenticate, forecastController.listLines);
router.post(
  '/:id/forecast-lines',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  forecastController.createLine,
);
router.get('/:id/forecast', authenticate, forecastController.getForecast);

router.get('/:id/budget-versions', authenticate, budgetController.listVersions);
router.post(
  '/:id/budget-versions',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  budgetController.createVersion,
);

router.get('/:id/variance', authenticate, budgetController.getVariance);

export default router;
