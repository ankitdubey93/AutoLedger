import { Router } from 'express';
import * as setupController from '../../controllers/inventory/setupController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/settings and /api/v1/inventory/setup — see docs/api.md.
 *
 * Reading is open to any member. Applying an industry profile is
 * configuration, so it takes OWNER or ADMIN, mirroring /unitecon/settings.
 */
const router = Router();

router.get('/settings', authenticate, setupController.getSettings);
router.get('/setup/profiles', authenticate, setupController.listProfiles);
router.patch('/settings', authenticate, requireRole('OWNER', 'ADMIN'), setupController.updateSettings);
router.post('/setup', authenticate, requireRole('OWNER', 'ADMIN'), setupController.apply);

export default router;
