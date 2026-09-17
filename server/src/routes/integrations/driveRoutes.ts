import { Router } from 'express';
import * as driveController from '../../controllers/integrations/driveController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/integrations/drive — see docs/api.md. Phase 19.3.
 *
 * Read is open to every member. Connecting (either mode), adding/editing/
 * removing a folder, and disconnecting need OWNER/ADMIN — this grants a
 * third party read access to files in the organization's own Drive, a
 * decision above ACCOUNTANT tier. Manual sync accepts ACCOUNTANT too,
 * matching every other AP-Flow write that only moves documents rather than
 * authorizing a new integration.
 *
 * The OAuth callback carries no `authenticate` — Google's redirect has no
 * session, and the OAuth `state` value is itself the credential
 * (driveConnectionService.completeConnect's own comment explains the
 * rule-1 exception this implies).
 */
const router = Router();

router.get('/', authenticate, driveController.getIntegration);
router.post('/connect', authenticate, requireRole('OWNER', 'ADMIN'), driveController.connect);
router.post(
  '/connect/service-account',
  authenticate,
  requireRole('OWNER', 'ADMIN'),
  driveController.connectServiceAccount,
);
router.get('/oauth/callback', driveController.oauthCallback);
router.delete('/', authenticate, requireRole('OWNER', 'ADMIN'), driveController.disconnect);

router.get('/folders', authenticate, driveController.listFolders);
router.post('/folders', authenticate, requireRole('OWNER', 'ADMIN'), driveController.createFolder);
router.patch('/folders/:id', authenticate, requireRole('OWNER', 'ADMIN'), driveController.updateFolder);
router.delete('/folders/:id', authenticate, requireRole('OWNER', 'ADMIN'), driveController.deleteFolder);
router.post(
  '/folders/:id/sync',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  driveController.syncFolder,
);

export default router;
