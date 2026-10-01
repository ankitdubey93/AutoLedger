import { Router } from 'express';
import * as migrationImportController from '../../controllers/accounting/migrationImportController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/migration-imports — see docs/api.md.
 *
 * Staging (create, patching a row, validate, preview) is bookkeeping, so it
 * takes OWNER, ADMIN or ACCOUNTANT — the same tier as /accounts and
 * /journals. Commit is narrower: OWNER or ADMIN only, matching
 * /fx-revaluations, because it creates accounts and posts an irreversible
 * journal entry on someone's behalf.
 */
const router = Router();

router.post('/', authenticate, requirePermission('imports.stage'), migrationImportController.create);
router.get('/', authenticate, requirePermission('imports.view'), migrationImportController.list);
router.get('/kinds', authenticate, requirePermission('imports.view'), migrationImportController.kinds);
router.post('/inspect', authenticate, requirePermission('imports.stage'), migrationImportController.inspect);
router.get('/:id', authenticate, requirePermission('imports.view'), migrationImportController.getOne);
router.get('/:id/rows', authenticate, requirePermission('imports.view'), migrationImportController.listRows);
router.patch(
  '/:id/rows/:rowId',
  authenticate,
  requirePermission('imports.stage'),
  migrationImportController.patchRow,
);
router.post(
  '/:id/rows/status',
  authenticate,
  requirePermission('imports.stage'),
  migrationImportController.setRowsStatus,
);
router.post(
  '/:id/validate',
  authenticate,
  requirePermission('imports.stage'),
  migrationImportController.validate,
);
router.get(
  '/:id/preview',
  authenticate,
  requirePermission('imports.stage'),
  migrationImportController.preview,
);
router.post('/:id/commit', authenticate, requirePermission('imports.commit'), migrationImportController.commit);
router.delete(
  '/:id',
  authenticate,
  requirePermission('imports.stage'),
  migrationImportController.remove,
);

export default router;
