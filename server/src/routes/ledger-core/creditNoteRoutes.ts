import { Router } from 'express';
import * as creditNoteController from '../../controllers/ledger-core/creditNoteController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/credit-notes — see docs/api.md (Phase 26).
 *
 * Reading is open to any member, like /invoices. Every write — including the
 * draft-only PATCH and DELETE — is bookkeeping, so it takes ACCOUNTANT or
 * above. An ISSUED credit note is corrected only by POST /:id/void, which
 * posts a reversal (guardrails rule 6).
 */
const router = Router();

router.get('/', authenticate, creditNoteController.list);
router.get('/:id', authenticate, creditNoteController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), creditNoteController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), creditNoteController.update);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), creditNoteController.remove);
router.post(
  '/:id/issue',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  creditNoteController.issue,
);
router.post(
  '/:id/void',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  creditNoteController.void_,
);
router.post(
  '/:id/allocations',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  creditNoteController.apply,
);

export default router;
