import { Router } from 'express';
import * as paymentTermController from '../../controllers/accounting/paymentTermController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/payment-terms — see docs/api.md.
 *
 * Reading is open to any member, matching /accounts and /customers. Writing
 * is bookkeeping, so it takes ACCOUNTANT or above.
 *
 * There is no GET /:id and no DELETE — a term is retired with
 * `isActive: false` via PATCH, matching accounts and customers.
 */
const router = Router();

router.get('/', authenticate, paymentTermController.list);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), paymentTermController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), paymentTermController.update);

export default router;
