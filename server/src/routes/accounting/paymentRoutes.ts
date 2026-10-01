import { Router } from 'express';
import * as paymentController from '../../controllers/accounting/paymentController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/payments — see docs/api.md.
 *
 * Reading is open to any member, matching /invoices and /bills. Recording a
 * payment is bookkeeping, so it takes ACCOUNTANT or above.
 *
 * There is no PATCH and no DELETE — a posted payment is corrected by voiding
 * it, which posts a reversal (guardrails rule 6).
 */
const router = Router();

router.get('/', authenticate, requirePermission('payments.view'), paymentController.list);
router.get('/:id', authenticate, requirePermission('payments.view'), paymentController.getOne);

router.post('/', authenticate, requirePermission('payments.create'), paymentController.create);
router.post(
  '/:id/void',
  authenticate,
  requirePermission('payments.void'),
  paymentController.void_,
);

export default router;
