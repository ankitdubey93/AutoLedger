import { Router } from 'express';
import * as recurringScheduleController from '../../controllers/accounting/recurringScheduleController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

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

router.get('/', authenticate, requirePermission('recurring.view'), recurringScheduleController.list);
router.get('/:id', authenticate, requirePermission('recurring.view'), recurringScheduleController.getOne);

router.post('/', authenticate, requirePermission('recurring.manage'), recurringScheduleController.create);
router.post('/:id/pause', authenticate, requirePermission('recurring.manage'), recurringScheduleController.pause);
router.post('/:id/resume', authenticate, requirePermission('recurring.manage'), recurringScheduleController.resume);
router.post('/:id/end', authenticate, requirePermission('recurring.manage'), recurringScheduleController.end);
router.post('/:id/run', authenticate, requirePermission('recurring.manage'), recurringScheduleController.run);

export default router;
