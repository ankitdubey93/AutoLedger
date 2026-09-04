import { Router } from 'express';
import * as auditController from '../controllers/auditController.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

/**
 * /api/v1/audit-logs — see docs/api.md.
 *
 * OWNER and ADMIN only — deliberately narrower than /reports and
 * /fiscal-periods, which any member may read. The trail records who did
 * what, including what an ACCOUNTANT did, so it is a control surface, not a
 * report; the bookkeeper does not get to read the log of their own actions
 * any more than they get to close a fiscal period.
 *
 * There is no POST, PATCH, PUT or DELETE on this resource, now or ever —
 * rows are written by trigger only (migrations 017/018).
 */
const router = Router();

router.get('/', authenticate, requireRole('OWNER', 'ADMIN'), auditController.list);
router.get('/:id', authenticate, requireRole('OWNER', 'ADMIN'), auditController.getOne);

export default router;
