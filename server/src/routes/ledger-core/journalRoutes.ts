import { Router } from 'express';
import * as journalController from '../../controllers/ledger-core/journalController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/journals — see docs/api.md.
 *
 * **There is no PUT and no DELETE, at any phase.** A posted entry is immutable
 * (guardrails rule 6); the correction path is POST /:id/reverse. Adding a
 * mutating route here would not even work — a trigger in migration 004 rejects
 * any UPDATE or DELETE on journal_entries and ledger_lines with SQLSTATE 0A000.
 *
 * Reading is open to any member, so a VIEWER can audit the books. Posting takes
 * ACCOUNTANT or above.
 */
const router = Router();

router.get('/', authenticate, journalController.list);
router.get('/:id', authenticate, journalController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), journalController.create);

router.post(
  '/:id/reverse',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  journalController.reverse,
);

export default router;
