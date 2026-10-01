import { Router } from 'express';
import * as accountController from '../../controllers/accounting/accountController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/accounts — see docs/api.md.
 *
 * Reading the chart is open to any member: a VIEWER looking at a report needs
 * to know what the account codes mean. Changing it is bookkeeping, so it takes
 * ACCOUNTANT or above.
 *
 * There is no DELETE. An account is retired with `isActive: false` — deleting
 * one that carries postings is refused by the FK anyway (ON DELETE RESTRICT),
 * and deleting one that does not would still break the audit trail's references.
 */
const router = Router();

router.get('/', authenticate, requirePermission('accounts.view'), accountController.list);
// Registered before /:id — otherwise Express would match "balances" as an
// account id and this route would never run.
router.get('/balances', authenticate, requirePermission('accounts.view'), accountController.balances);
router.get('/:id', authenticate, requirePermission('accounts.view'), accountController.getOne);
router.get('/:id/ledger', authenticate, requirePermission('accounts.view'), accountController.ledger);

router.post('/', authenticate, requirePermission('accounts.manage'), accountController.create);

router.patch(
  '/:id',
  authenticate,
  requirePermission('accounts.manage'),
  accountController.update,
);

export default router;
