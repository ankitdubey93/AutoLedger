import { Router } from 'express';
import * as modelController from '../../controllers/fpa-engine/modelController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/fpa-engine/models — see docs/api.md.
 *
 * Read is open to every member including VIEWER. Creating or editing a model
 * or its scenarios needs ACCOUNTANT and above — forecasting is accountant
 * work. Deleting a model needs OWNER/ADMIN only, because it cascades away
 * every scenario and assumption on it.
 */
const router = Router();

router.get('/', authenticate, modelController.listModels);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), modelController.createModel);
router.get('/:id', authenticate, modelController.getModel);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), modelController.updateModel);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN'), modelController.deleteModel);
router.get('/:id/scenarios', authenticate, modelController.listScenarios);
router.post(
  '/:id/scenarios',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  modelController.createScenario,
);
router.get('/:id/comparison', authenticate, modelController.comparison);

export default router;
