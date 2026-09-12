import { Router } from 'express';
import * as settingsController from '../../controllers/unitecon/settingsController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/unitecon/settings — see docs/api.md.
 *
 * Reading is open to any member. Writing takes OWNER or ADMIN, deliberately
 * NOT the ACCOUNTANT-inclusive tier used by accounts and journals:
 * `grossMarginBps` and the acquisition-account set silently reprice every
 * LTV and CAC figure in the app, the same reasoning `/ledger-core/settings`
 * records for its own OWNER/ADMIN ruling.
 */
const router = Router();

router.get('/', authenticate, settingsController.get);
router.patch('/', authenticate, requireRole('OWNER', 'ADMIN'), settingsController.update);

export default router;
