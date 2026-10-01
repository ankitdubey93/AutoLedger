import { Router } from 'express';
import * as fiscalPeriodController from '../../controllers/accounting/fiscalPeriodController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/fiscal-periods — see docs/api.md.
 *
 * Reading is open to any member, matching /reports and /settings — a VIEWER
 * reading a report needs to know which periods are closed. Generating,
 * closing and reopening are organization configuration, so they take OWNER
 * or ADMIN, deliberately NOT the ACCOUNTANT-inclusive bookkeeping tier used
 * by /accounts and /journals: closing a period stops the bookkeeper from
 * posting, so the bookkeeper does not hold the key.
 *
 * Locking is narrower still — OWNER only. It is irreversible (there is no
 * LOCKED -> anything transition in FISCAL_PERIOD_TRANSITIONS), the same
 * reasoning that narrows bill approval from bill entry.
 *
 * /generate is declared before /:id so a literal path is never shadowed by
 * the param route, matching the ordering discipline in billRoutes.ts.
 */
const router = Router();

router.get('/', authenticate, requirePermission('periods.view'), fiscalPeriodController.list);
router.post('/generate', authenticate, requirePermission('periods.close'), fiscalPeriodController.generate);
router.get('/:id', authenticate, requirePermission('periods.view'), fiscalPeriodController.getOne);
router.post('/:id/close', authenticate, requirePermission('periods.close'), fiscalPeriodController.close);
router.post('/:id/reopen', authenticate, requirePermission('periods.close'), fiscalPeriodController.reopen);
router.post('/:id/lock', authenticate, requirePermission('periods.lock'), fiscalPeriodController.lock);

export default router;
