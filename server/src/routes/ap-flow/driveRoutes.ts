import { Router } from 'express';
import * as driveController from '../../controllers/integrations/driveController.js';

/**
 * Phase 19.3 legacy alias. The Drive integration moved to
 * /api/v1/integrations/drive; this ONE path stays because the redirect URI
 * is registered in an operator's Google Cloud Console, outside this repo,
 * and a stale .env would otherwise 404 with nothing to explain it.
 * Remove once no .env in use still names it.
 */
const router = Router();

router.get('/oauth/callback', driveController.oauthCallback);

export default router;
