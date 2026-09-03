import { Router } from 'express';
import * as invoiceController from '../../controllers/ledger-core/invoiceController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/invoices — see docs/api.md.
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

router.get('/', authenticate, invoiceController.list);
router.get('/:id', authenticate, invoiceController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), invoiceController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), invoiceController.update);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), invoiceController.remove);
router.post(
  '/:id/issue',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  invoiceController.issue,
);
router.post(
  '/:id/void',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  invoiceController.void_,
);

export default router;
