import { Router } from 'express';
import * as debitNoteController from '../../controllers/accounting/debitNoteController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/debit-notes — see docs/api.md (Phase 26).
 *
 * Reading is open to any member, like /bills. Every write — including the
 * draft-only PATCH and DELETE — is bookkeeping, so it takes ACCOUNTANT or
 * above. An ISSUED debit note is corrected only by POST /:id/void, which
 * posts a reversal (guardrails rule 6).
 */
const router = Router();

router.get('/', authenticate, requirePermission('debit_notes.view'), debitNoteController.list);
router.get('/:id', authenticate, requirePermission('debit_notes.view'), debitNoteController.getOne);

router.post('/', authenticate, requirePermission('debit_notes.edit'), debitNoteController.create);
router.patch('/:id', authenticate, requirePermission('debit_notes.edit'), debitNoteController.update);
router.delete('/:id', authenticate, requirePermission('debit_notes.edit'), debitNoteController.remove);
router.post(
  '/:id/issue',
  authenticate,
  requirePermission('debit_notes.issue'),
  debitNoteController.issue,
);
router.post(
  '/:id/void',
  authenticate,
  requirePermission('debit_notes.void'),
  debitNoteController.void_,
);
router.post(
  '/:id/allocations',
  authenticate,
  requirePermission('debit_notes.issue'),
  debitNoteController.apply,
);

export default router;
