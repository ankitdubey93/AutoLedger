import { Router } from 'express';
import * as debitNoteController from '../../controllers/ledger-core/debitNoteController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/debit-notes — see docs/api.md (Phase 26).
 *
 * Reading is open to any member, like /bills. Every write — including the
 * draft-only PATCH and DELETE — is bookkeeping, so it takes ACCOUNTANT or
 * above. An ISSUED debit note is corrected only by POST /:id/void, which
 * posts a reversal (guardrails rule 6).
 */
const router = Router();

router.get('/', authenticate, debitNoteController.list);
router.get('/:id', authenticate, debitNoteController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), debitNoteController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), debitNoteController.update);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), debitNoteController.remove);
router.post(
  '/:id/issue',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  debitNoteController.issue,
);
router.post(
  '/:id/void',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  debitNoteController.void_,
);
router.post(
  '/:id/allocations',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  debitNoteController.apply,
);

export default router;
