import { Router } from 'express';
import * as abnController from '../../controllers/accounting/abnController.js';
import { authenticate } from '../../middleware/auth.js';
import { allowAnyMember } from '../../middleware/rbac.js';
import { requireRegion } from '../../middleware/region.js';

/** /api/v1/abn — Phase 49f. */
const router = Router();

router.get('/status', authenticate, allowAnyMember, requireRegion('AU'), abnController.status);
router.get('/:abn', authenticate, allowAnyMember, requireRegion('AU'), abnController.lookup);

export default router;
