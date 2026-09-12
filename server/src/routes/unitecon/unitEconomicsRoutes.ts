import { Router } from 'express';
import * as unitEconomicsController from '../../controllers/unitecon/unitEconomicsController.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * /api/v1/unitecon/unit-economics — see docs/api.md.
 *
 * Reading is open to every member including VIEWER, matching /cohorts.
 */
const router = Router();

router.get('/', authenticate, unitEconomicsController.getUnitEconomics);

export default router;
