import { Router } from 'express';
import * as bankImportController from '../../controllers/accounting/bankImportController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/bank-imports — see docs/api.md.
 *
 * Reading is open to any member. Importing a statement is bookkeeping, so
 * it takes ACCOUNTANT or above — the same role set /payments uses, since a
 * matched import can post real payments.
 *
 * There is no PATCH and no DELETE — an import is a record of what was
 * uploaded and when (guardrails rule 6).
 */
const router = Router();

router.get('/', authenticate, requirePermission('bank.view'), bankImportController.list);
router.get('/:id', authenticate, requirePermission('bank.view'), bankImportController.getOne);

router.post('/', authenticate, requirePermission('bank.reconcile'), bankImportController.create);

export default router;
