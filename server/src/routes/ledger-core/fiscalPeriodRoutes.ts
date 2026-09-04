import { Router } from 'express';
import * as fiscalPeriodController from '../../controllers/ledger-core/fiscalPeriodController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/fiscal-periods — see docs/api.md.
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

router.get('/', authenticate, fiscalPeriodController.list);
router.post('/generate', authenticate, requireRole('OWNER', 'ADMIN'), fiscalPeriodController.generate);
router.get('/:id', authenticate, fiscalPeriodController.getOne);
router.post('/:id/close', authenticate, requireRole('OWNER', 'ADMIN'), fiscalPeriodController.close);
router.post('/:id/reopen', authenticate, requireRole('OWNER', 'ADMIN'), fiscalPeriodController.reopen);
router.post('/:id/lock', authenticate, requireRole('OWNER'), fiscalPeriodController.lock);

export default router;
