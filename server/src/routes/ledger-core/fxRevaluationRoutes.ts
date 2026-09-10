import { Router } from 'express';
import * as fxRevaluationController from '../../controllers/ledger-core/fxRevaluationController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/fx-revaluations — see docs/api.md.
 *
 * Reading is open to any member, matching /reports and /fx-rates. Running a
 * revaluation is narrower — OWNER or ADMIN only, not the ACCOUNTANT-inclusive
 * bookkeeping tier used by /accounts and /journals: it posts to the GL on
 * someone's behalf and is closer to /fiscal-periods' close/reopen than to an
 * ordinary document post.
 *
 * There is no PATCH/DELETE — a revaluation has no status and no lifecycle
 * (migration 026's header comment); a wrong one is corrected by the next
 * period's revaluation, not by editing this one.
 */
const router = Router();

router.get('/', authenticate, fxRevaluationController.list);
router.get('/:id', authenticate, fxRevaluationController.getOne);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN'), fxRevaluationController.run);

export default router;
