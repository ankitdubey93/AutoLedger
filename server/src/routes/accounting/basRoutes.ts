import { Router } from 'express';
import * as basController from '../../controllers/accounting/basController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { requireRegion } from '../../middleware/region.js';

/** /api/v1/bas — Phase 49d. Business activity statements, for an Australian organization. */
const router = Router();

const au = requireRegion('AU');

router.get('/', authenticate, requirePermission('bas.view'), au, basController.list);
router.post('/', authenticate, requirePermission('bas.prepare'), au, basController.create);
router.get('/:id', authenticate, requirePermission('bas.view'), au, basController.getOne);
router.patch('/:id', authenticate, requirePermission('bas.prepare'), au, basController.update);
router.delete('/:id', authenticate, requirePermission('bas.prepare'), au, basController.remove);
router.get('/:id/events', authenticate, requirePermission('bas.view'), au, basController.events);
router.post('/:id/adjustments', authenticate, requirePermission('bas.prepare'), au, basController.addAdjustment);
router.delete('/:id/adjustments/:adjustmentId', authenticate, requirePermission('bas.prepare'), au, basController.removeAdjustment);
router.post('/:id/finalise', authenticate, requirePermission('bas.finalise'), au, basController.finalise);
router.post('/:id/reopen', authenticate, requirePermission('bas.finalise'), au, basController.reopen);
router.post('/:id/lodge', authenticate, requirePermission('bas.finalise'), au, basController.lodge);

export default router;
