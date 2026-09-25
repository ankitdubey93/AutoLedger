import { Router } from 'express';
import * as locationController from '../../controllers/inventory/locationController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/locations — see docs/api.md.
 *
 * Reading is open to any member. Writing is catalogue configuration, so it
 * takes OWNER or ADMIN. There is no DELETE — a location is retired with
 * `isActive: false` via PATCH.
 */
const router = Router();

router.get('/', authenticate, locationController.list);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN'), locationController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN'), locationController.update);

export default router;
