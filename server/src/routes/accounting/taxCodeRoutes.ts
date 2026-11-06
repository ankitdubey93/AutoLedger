import { Router } from 'express';
import * as taxCodeController from '../../controllers/accounting/taxCodeController.js';
import { authenticate } from '../../middleware/auth.js';
import { allowAnyMember } from '../../middleware/rbac.js';
import { requireRegion } from '../../middleware/region.js';

/** /api/v1/tax-codes — Phase 49b. A closed catalogue any member's document form needs. */
const router = Router();

router.get('/', authenticate, allowAnyMember, requireRegion('AU'), taxCodeController.list);

export default router;
