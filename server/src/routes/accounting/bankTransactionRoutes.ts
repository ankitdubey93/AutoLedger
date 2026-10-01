import { Router } from 'express';
import * as bankTransactionController from '../../controllers/accounting/bankTransactionController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/bank-transactions — see docs/api.md.
 *
 * Reading is open to any member. Every mutation (rescore, match, post-journal,
 * unmatch, ignore, unignore) takes ACCOUNTANT or above, matching /payments —
 * match, post-journal and unmatch each post or void a real GL entry.
 *
 * There is no PATCH and no DELETE.
 */
const router = Router();

router.get('/', authenticate, requirePermission('bank.view'), bankTransactionController.list);
router.get('/:id', authenticate, requirePermission('bank.view'), bankTransactionController.getOne);

router.post(
  '/:id/rescore',
  authenticate,
  requirePermission('bank.reconcile'),
  bankTransactionController.rescore,
);
router.post(
  '/:id/match',
  authenticate,
  requirePermission('bank.reconcile'),
  bankTransactionController.match,
);
router.post(
  '/:id/post-journal',
  authenticate,
  requirePermission('bank.reconcile'),
  bankTransactionController.postJournal,
);
router.post(
  '/:id/unmatch',
  authenticate,
  requirePermission('bank.reconcile'),
  bankTransactionController.unmatch,
);
router.post(
  '/:id/ignore',
  authenticate,
  requirePermission('bank.reconcile'),
  bankTransactionController.ignore,
);
router.post(
  '/:id/unignore',
  authenticate,
  requirePermission('bank.reconcile'),
  bankTransactionController.unignore,
);

export default router;
