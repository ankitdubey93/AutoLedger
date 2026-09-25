import { Router } from 'express';
import * as codeSchemeController from '../../controllers/inventory/codeSchemeController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/inventory/code-schemes — see docs/api.md.
 *
 * `/presets` and `/preview` are registered before `/:id`-shaped routes so a
 * literal segment can never be swallowed by a param route. Reading (and
 * previewing, which never writes) is open to any member; writing is
 * catalogue configuration, so it takes OWNER or ADMIN. There is no DELETE —
 * a scheme is retired with `isActive: false` via PATCH.
 */
const router = Router();

router.get('/', authenticate, codeSchemeController.list);
router.get('/presets', authenticate, codeSchemeController.presets);
router.post('/preview', authenticate, codeSchemeController.preview);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN'), codeSchemeController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN'), codeSchemeController.update);

export default router;
