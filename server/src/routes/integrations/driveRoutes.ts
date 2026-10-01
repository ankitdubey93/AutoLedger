import { Router } from 'express';
import * as driveController from '../../controllers/integrations/driveController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/integrations/drive — see docs/api.md. Phase 19.3.
 *
 * Read is open to every member. Connecting (either mode), adding/editing/
 * removing a folder, and disconnecting need OWNER/ADMIN — this grants a
 * third party read access to files in the organization's own Drive, a
 * decision above ACCOUNTANT tier. Manual sync accepts ACCOUNTANT too,
 * matching every other Capture write that only moves documents rather than
 * authorizing a new integration.
 *
 * The OAuth callback carries no `authenticate` — Google's redirect has no
 * session, and the OAuth `state` value is itself the credential
 * (driveConnectionService.completeConnect's own comment explains the
 * rule-1 exception this implies).
 */
const router = Router();

router.get('/', authenticate, requirePermission('integrations.view'), driveController.getIntegration);
router.post('/connect', authenticate, requirePermission('integrations.manage'), driveController.connect);
router.post(
  '/connect/service-account',
  authenticate,
  requirePermission('integrations.manage'),
  driveController.connectServiceAccount,
);
router.get('/oauth/callback', driveController.oauthCallback);
router.delete('/', authenticate, requirePermission('integrations.manage'), driveController.disconnect);

router.get('/folders', authenticate, requirePermission('integrations.view'), driveController.listFolders);
router.post('/folders', authenticate, requirePermission('integrations.manage'), driveController.createFolder);
router.patch('/folders/:id', authenticate, requirePermission('integrations.manage'), driveController.updateFolder);
router.delete('/folders/:id', authenticate, requirePermission('integrations.manage'), driveController.deleteFolder);
router.post(
  '/folders/:id/sync',
  authenticate,
  requirePermission('integrations.sync'),
  driveController.syncFolder,
);

export default router;
