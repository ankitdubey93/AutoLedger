import { Router } from 'express';
import * as bvaController from '../../controllers/boarddeck/bvaController.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * /api/v1/boarddeck/bva — see docs/api.md.
 *
 * Reading is open to every member including VIEWER, matching /forecaster's
 * own variance route.
 */
const router = Router();

router.get('/', authenticate, bvaController.getBva);

export default router;
