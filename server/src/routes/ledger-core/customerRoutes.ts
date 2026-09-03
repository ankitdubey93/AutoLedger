import { Router } from 'express';
import * as customerController from '../../controllers/ledger-core/customerController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/customers — see docs/api.md.
 *
 * Reading is open to any member, matching /accounts. Writing is bookkeeping,
 * so it takes ACCOUNTANT or above, matching accounts and journals.
 *
 * There is no DELETE — a customer is retired with `isActive: false` via
 * PATCH, matching accounts.
 */
const router = Router();

router.get('/', authenticate, customerController.list);
router.get('/:id', authenticate, customerController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), customerController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), customerController.update);

export default router;
