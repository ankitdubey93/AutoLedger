import { Router } from 'express';
import * as captureSettingsController from '../../controllers/capture/captureSettingsController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/capture/settings — see docs/api.md. Read is open to every member
 * including VIEWER; writing the auto-post gates needs OWNER or ADMIN — a
 * setting that changes what posts to the GL with no human is not an
 * ACCOUNTANT-level decision.
 */
const router = Router();

router.get('/', authenticate, captureSettingsController.getSettings);
router.put('/', authenticate, requireRole('OWNER', 'ADMIN'), captureSettingsController.updateSettings);

export default router;
