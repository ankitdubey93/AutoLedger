import { Router } from 'express';
import * as bankRuleController from '../../controllers/accounting/bankRuleController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/bank-rules — see docs/api.md.
 *
 * Reading is open to any member, matching /accounts and /customers. Writing
 * is bookkeeping, so it takes ACCOUNTANT or above.
 *
 * There is no GET /:id and no DELETE — a rule is retired with
 * `isActive: false` via PATCH, matching accounts and customers.
 */
const router = Router();

router.get('/', authenticate, bankRuleController.list);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), bankRuleController.create);
router.post('/apply', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), bankRuleController.apply);
router.patch('/:id', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), bankRuleController.update);

export default router;
