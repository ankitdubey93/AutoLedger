import { Router } from 'express';
import * as setupController from '../../controllers/inventory/setupController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/settings and /api/v1/inventory/setup — see docs/api.md.
 *
 * Reading is open to any member. Applying an industry profile is
 * configuration, so it takes OWNER or ADMIN, mirroring /unitecon/settings.
 */
const router = Router();

router.get('/settings', authenticate, requirePermission('inventory.view'), setupController.getSettings);
router.get('/setup/profiles', authenticate, requirePermission('inventory.view'), setupController.listProfiles);
router.patch('/settings', authenticate, requirePermission('inventory.configure'), setupController.updateSettings);
router.post('/setup', authenticate, requirePermission('inventory.configure'), setupController.apply);

export default router;
