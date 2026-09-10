import { Router } from 'express';
import * as migrationImportController from '../../controllers/ledger-core/migrationImportController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ledger-core/migration-imports — see docs/api.md.
 *
 * Staging (create, patching a row, validate, preview) is bookkeeping, so it
 * takes OWNER, ADMIN or ACCOUNTANT — the same tier as /accounts and
 * /journals. Commit is narrower: OWNER or ADMIN only, matching
 * /fx-revaluations, because it creates accounts and posts an irreversible
 * journal entry on someone's behalf.
 */
const router = Router();

router.post('/', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), migrationImportController.create);
router.get('/', authenticate, migrationImportController.list);
router.get('/:id', authenticate, migrationImportController.getOne);
router.get('/:id/rows', authenticate, migrationImportController.listRows);
router.patch(
  '/:id/rows/:rowId',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  migrationImportController.patchRow,
);
router.post(
  '/:id/validate',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  migrationImportController.validate,
);
router.get(
  '/:id/preview',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  migrationImportController.preview,
);
router.post('/:id/commit', authenticate, requireRole('OWNER', 'ADMIN'), migrationImportController.commit);
router.delete(
  '/:id',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  migrationImportController.remove,
);

export default router;
