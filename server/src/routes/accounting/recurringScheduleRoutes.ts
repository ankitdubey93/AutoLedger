import { Router } from 'express';
import * as recurringScheduleController from '../../controllers/accounting/recurringScheduleController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/recurring-schedules — see docs/api.md.
 *
 * Reading is open to any authenticated member. Writing is bookkeeping,
 * so it takes ACCOUNTANT or above.
 *
 * There is no DELETE — a schedule is ended with POST /:id/end,
 * never deleted. To change a schedule, end it and create a new one.
 */
const router = Router();

router.get('/', authenticate, recurringScheduleController.list);
router.get('/:id', authenticate, recurringScheduleController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), recurringScheduleController.create);
router.post('/:id/pause', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), recurringScheduleController.pause);
router.post('/:id/resume', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), recurringScheduleController.resume);
router.post('/:id/end', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), recurringScheduleController.end);
router.post('/:id/run', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), recurringScheduleController.run);

export default router;
