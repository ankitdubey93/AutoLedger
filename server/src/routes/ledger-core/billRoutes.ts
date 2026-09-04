import { Router } from 'express';
import * as billController from '../../controllers/ledger-core/billController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/bills — see docs/api.md.
 *
 * Reading is open to any member, matching /invoices. Entering a bill — POST,
 * PATCH, DELETE (both draft/in-review only), and submitting it for review —
 * is bookkeeping, so it takes ACCOUNTANT or above.
 *
 * Approval is deliberately narrower than entry: ACCOUNTANT can enter and
 * submit a bill but not approve it. This is a segregation-of-duties control
 * — the reason the review queue exists — not an oversight.
 *
 * PATCH/DELETE do not violate guardrails rule 6: both are refused by the
 * service and by a database trigger for anything that is not DRAFT or
 * AWAITING_APPROVAL, which has posted nothing to the ledger. A POSTED bill's
 * only correction path is POST /:id/void, which posts a reversing journal
 * entry.
 */
const router = Router();

router.get('/', authenticate, billController.list);
router.get('/:id', authenticate, billController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), billController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), billController.update);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), billController.remove);
router.post(
  '/:id/submit',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  billController.submit,
);
router.post('/:id/approve', authenticate, requireRole('OWNER', 'ADMIN'), billController.approve);
router.post(
  '/:id/void',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  billController.void_,
);

export default router;
