import { Router } from 'express';
import * as assumptionController from '../../controllers/fpa-engine/assumptionController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/fpa-engine/scenarios/:id/assumptions — see docs/api.md.
 *
 * Mounted with `{ mergeParams: true }` so `:id` (the scenario id) from the
 * parent router is visible here — without it, `requireParam(req, 'id')`
 * would 400 on every nested route.
 */
const router = Router({ mergeParams: true });

router.get('/', authenticate, assumptionController.list);
router.put('/:accountId', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), assumptionController.upsert);
router.delete(
  '/:accountId',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  assumptionController.remove,
);

export default router;
