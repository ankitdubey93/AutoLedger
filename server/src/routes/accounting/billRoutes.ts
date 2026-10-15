import { Router } from 'express';
import * as billController from '../../controllers/accounting/billController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/bills — see docs/api.md.
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

router.get('/', authenticate, requirePermission('bills.view'), billController.list);
router.get('/:id', authenticate, requirePermission('bills.view'), billController.getOne);

router.post('/', authenticate, requirePermission('bills.edit'), billController.create);
router.patch('/:id', authenticate, requirePermission('bills.edit'), billController.update);
router.delete('/:id', authenticate, requirePermission('bills.edit'), billController.remove);
router.post(
  '/:id/submit',
  authenticate,
  requirePermission('bills.edit'),
  billController.submit,
);
router.get(
  '/:id/available-credits',
  authenticate,
  requirePermission('bills.approve'),
  billController.availableCredits,
);
router.post('/:id/approve', authenticate, requirePermission('bills.approve'), billController.approve);
router.post(
  '/:id/void',
  authenticate,
  requirePermission('bills.void'),
  billController.void_,
);

router.post(
  '/:id/apply-prepayment',
  authenticate,
  requirePermission('bills.approve'),
  billController.applyPrepayment,
);

export default router;
