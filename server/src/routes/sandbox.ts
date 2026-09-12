import { Router } from 'express';
import * as sandboxController from '../controllers/sandboxController.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

/**
 * /api/v1/sandbox — see docs/api.md.
 *
 * Read is open to every member — knowing whether sample data is loaded is
 * harmless. Loading and unloading need OWNER: a load writes two years of
 * financial documents into the organization's own books, which is an
 * owner-level act, not merely an admin-level one.
 */
const router = Router();

router.get('/', authenticate, sandboxController.status);
router.post('/load', authenticate, requireRole('OWNER'), sandboxController.load);
router.delete('/', authenticate, requireRole('OWNER'), sandboxController.unload);

export default router;
