import { Router } from 'express';
import * as closeRunController from '../../controllers/boarddeck/closeRunController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/boarddeck/close-runs — see docs/api.md.
 *
 * Reading is open to any member including VIEWER. Creating/re-running a
 * close run needs ACCOUNTANT and above. Closing the period is OWNER/ADMIN
 * only — it writes to LedgerCore's fiscal-period lifecycle on the caller's
 * behalf, the same tier /fiscal-periods/:id/lock and /fx-revaluations use.
 */
const router = Router();

router.get('/', authenticate, closeRunController.list);
router.get('/:id', authenticate, closeRunController.getOne);
router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), closeRunController.create);
router.post('/:id/rerun', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), closeRunController.rerun);
router.post('/:id/close-period', authenticate, requireRole('OWNER', 'ADMIN'), closeRunController.closePeriod);

export default router;
