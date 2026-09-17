import { Router } from 'express';
import * as apFlowDriveController from '../../controllers/ap-flow/apFlowDriveController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ap-flow/drive — see docs/api.md. Phase 19.2.
 *
 * Read is open to every member. Connecting, choosing a folder, and
 * disconnecting need OWNER/ADMIN — this grants a third party read access to
 * files in the organization's own Drive, a decision above ACCOUNTANT tier.
 * Manual sync accepts ACCOUNTANT too, matching every other AP-Flow write
 * that only moves documents rather than authorizing a new integration.
 *
 * The OAuth callback carries no `authenticate` — Google's redirect has no
 * session, and the OAuth `state` value is itself the credential
 * (driveConnectionService.completeConnect's own comment explains the
 * rule-1 exception this implies).
 */
const router = Router();

router.get('/', authenticate, apFlowDriveController.getConnection);
router.post('/connect', authenticate, requireRole('OWNER', 'ADMIN'), apFlowDriveController.connect);
router.get('/oauth/callback', apFlowDriveController.oauthCallback);
router.put('/folder', authenticate, requireRole('OWNER', 'ADMIN'), apFlowDriveController.setFolder);
router.post('/sync', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), apFlowDriveController.sync);
router.delete('/', authenticate, requireRole('OWNER', 'ADMIN'), apFlowDriveController.disconnect);

export default router;
