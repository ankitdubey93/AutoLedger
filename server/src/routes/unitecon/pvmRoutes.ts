import { Router } from 'express';
import * as pvmController from '../../controllers/unitecon/pvmController.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * /api/v1/unitecon/pvm — see docs/api.md.
 *
 * Reading is open to every member including VIEWER, matching /cohorts and
 * /unit-economics.
 */
const router = Router();

router.get('/', authenticate, pvmController.getPvm);

export default router;
