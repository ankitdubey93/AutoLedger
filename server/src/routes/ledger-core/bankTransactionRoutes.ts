import { Router } from 'express';
import * as bankTransactionController from '../../controllers/ledger-core/bankTransactionController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/bank-transactions — see docs/api.md.
 *
 * Reading is open to any member. Every mutation (rescore, match, unmatch,
 * ignore, unignore) takes ACCOUNTANT or above, matching /payments — match
 * and unmatch each post or void a real GL entry.
 *
 * There is no PATCH and no DELETE.
 */
const router = Router();

router.get('/', authenticate, bankTransactionController.list);
router.get('/:id', authenticate, bankTransactionController.getOne);

router.post(
  '/:id/rescore',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  bankTransactionController.rescore,
);
router.post(
  '/:id/match',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  bankTransactionController.match,
);
router.post(
  '/:id/unmatch',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  bankTransactionController.unmatch,
);
router.post(
  '/:id/ignore',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  bankTransactionController.ignore,
);
router.post(
  '/:id/unignore',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  bankTransactionController.unignore,
);

export default router;
