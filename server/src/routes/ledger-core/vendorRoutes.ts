import { Router } from 'express';
import * as vendorController from '../../controllers/ledger-core/vendorController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/vendors — see docs/api.md.
 *
 * Reading is open to any member, matching /customers. Writing is bookkeeping,
 * so it takes ACCOUNTANT or above, matching customers and accounts.
 *
 * There is no DELETE — a vendor is retired with `isActive: false` via PATCH,
 * matching customers.
 */
const router = Router();

router.get('/', authenticate, vendorController.list);
router.get('/:id', authenticate, vendorController.getOne);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), vendorController.create);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), vendorController.update);

export default router;
