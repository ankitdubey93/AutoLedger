import { Router } from 'express';
import * as appController from '../controllers/appController.js';
import { authenticate } from '../middleware/auth.js';

/**
 * /api/v1/apps — see docs/api.md.
 *
 * Authenticated but not role-gated: every member of an organization may see
 * which portfolio apps exist. Per-app authorization happens inside each app's
 * own routes via requireRole, the same as any other module.
 */
const router = Router();

router.get('/', authenticate, appController.listApps);

export default router;
