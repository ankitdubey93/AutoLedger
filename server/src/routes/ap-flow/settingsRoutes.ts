import { Router } from 'express';
import * as apFlowSettingsController from '../../controllers/ap-flow/apFlowSettingsController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ap-flow/settings — see docs/api.md. Read is open to every member
 * including VIEWER; writing the auto-post gates needs OWNER or ADMIN — a
 * setting that changes what posts to the GL with no human is not an
 * ACCOUNTANT-level decision.
 */
const router = Router();

router.get('/', authenticate, apFlowSettingsController.getSettings);
router.put('/', authenticate, requireRole('OWNER', 'ADMIN'), apFlowSettingsController.updateSettings);

export default router;
