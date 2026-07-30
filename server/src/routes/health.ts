import { Router } from 'express';
import { getHealth } from '../controllers/healthController.js';

const router = Router();

// GET /api/v1/health — public. The auth middleware arrives in Phase 1 and this
// route stays outside it: a liveness probe cannot depend on a valid token.
router.get('/', getHealth);

export default router;
