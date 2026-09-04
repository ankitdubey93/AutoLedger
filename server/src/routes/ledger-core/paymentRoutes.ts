import { Router } from 'express';
import * as paymentController from '../../controllers/ledger-core/paymentController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/payments — see docs/api.md.
 *
 * Reading is open to any member, matching /invoices and /bills. Recording a
 * payment is bookkeeping, so it takes ACCOUNTANT or above.
 *
 * There is no PATCH and no DELETE — a posted payment is corrected by voiding
 * it, which posts a reversal (guardrails rule 6).
 */
const router = Router();

router.get('/', authenticate, paymentController.list);
router.get('/:id', authenticate, paymentController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), paymentController.create);
router.post(
  '/:id/void',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  paymentController.void_,
);

export default router;
