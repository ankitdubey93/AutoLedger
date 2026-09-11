import { Router } from 'express';
import * as modelController from '../../controllers/fpa-engine/modelController.js';
import assumptionRoutes from './assumptionRoutes.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/fpa-engine/scenarios — see docs/api.md.
 *
 * Mutations need ACCOUNTANT and above, matching modelRoutes.ts — a scenario
 * is a sibling resource of a model, not a posted document, so there is no
 * OWNER/ADMIN-only gate here.
 */
const router = Router();

router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), modelController.updateScenario);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), modelController.deleteScenario);
router.get('/:id/projection', authenticate, modelController.projection);
router.use('/:id/assumptions', assumptionRoutes);

export default router;
