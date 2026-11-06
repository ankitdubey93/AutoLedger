import { Router } from 'express';
import * as invoiceController from '../../controllers/accounting/invoiceController.js';
import * as invoiceSendController from '../../controllers/accounting/invoiceSendController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/invoices — see docs/api.md.
 *
 * Reading is open to any member, matching /accounts and /journals. Writing —
 * including PATCH and DELETE, both draft-only — is bookkeeping, so it takes
 * ACCOUNTANT or above.
 *
 * PATCH/DELETE do not violate guardrails rule 6: both are refused by the
 * service and by a database trigger for anything that is not a DRAFT, which
 * has posted nothing to the ledger. An ISSUED invoice's only correction path
 * is POST /:id/void, which posts a reversing journal entry.
 */
const router = Router();

router.get('/', authenticate, requirePermission('invoices.view'), invoiceController.list);
router.get('/:id/pdf', authenticate, requirePermission('invoices.view'), invoiceController.pdf);
router.get('/:id', authenticate, requirePermission('invoices.view'), invoiceController.getOne);

router.post('/', authenticate, requirePermission('invoices.edit'), invoiceController.create);
router.patch('/:id', authenticate, requirePermission('invoices.edit'), invoiceController.update);
router.delete('/:id', authenticate, requirePermission('invoices.edit'), invoiceController.remove);
router.get(
  '/:id/available-credits',
  authenticate,
  requirePermission('invoices.issue'),
  invoiceController.availableCredits,
);
router.post(
  '/:id/issue',
  authenticate,
  requirePermission('invoices.issue'),
  invoiceController.issue,
);
router.post(
  '/:id/void',
  authenticate,
  requirePermission('invoices.void'),
  invoiceController.void_,
);

router.post(
  '/:id/apply-deposit',
  authenticate,
  requirePermission('invoices.issue'),
  invoiceController.applyDeposit,
);

router.post('/:id/send', authenticate, requirePermission('invoices.send'), invoiceSendController.send);
router.get(
  '/:id/sends',
  authenticate,
  requirePermission('invoices.view'),
  invoiceSendController.listSends,
);
router.post(
  '/:id/sends/:sendId/revoke',
  authenticate,
  requirePermission('invoices.send'),
  invoiceSendController.revokeSend,
);

export default router;
