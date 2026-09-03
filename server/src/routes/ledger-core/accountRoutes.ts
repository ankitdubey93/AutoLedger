import { Router } from 'express';
import * as accountController from '../../controllers/ledger-core/accountController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/accounts — see docs/api.md.
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

router.get('/', authenticate, accountController.list);
// Registered before /:id — otherwise Express would match "balances" as an
// account id and this route would never run.
router.get('/balances', authenticate, accountController.balances);
router.get('/:id', authenticate, accountController.getOne);
router.get('/:id/ledger', authenticate, accountController.ledger);

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), accountController.create);

router.patch(
  '/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  accountController.update,
);

export default router;
