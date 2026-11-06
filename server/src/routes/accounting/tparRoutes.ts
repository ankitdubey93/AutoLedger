import { Router } from 'express';
import * as tparController from '../../controllers/accounting/tparController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { requireRegion } from '../../middleware/region.js';

/** /api/v1/tpar — Phase 49h. */
const router = Router();

const au = requireRegion('AU');

router.get('/:year', authenticate, requirePermission('bas.view'), au, tparController.report);
router.post('/:year/lodge', authenticate, requirePermission('bas.finalise'), au, tparController.lodge);

export default router;
