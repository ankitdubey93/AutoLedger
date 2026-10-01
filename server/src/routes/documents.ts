import { Router } from 'express';
import * as documentController from '../controllers/documentController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { singleFileUpload } from '../middleware/upload.js';

/**
 * /api/v1/documents — see docs/api.md.
 *
 * Read is open to every member including VIEWER; writing a file or a link
 * needs ACCOUNTANT and above; destroying a document needs ADMIN and above.
 *
 * `singleFileUpload` runs AFTER `requirePermission` on the upload route, so a
 * VIEWER's oversized body is rejected before it is ever buffered into
 * memory.
 */
const router = Router();

router.post(
  '/',
  authenticate,
  requirePermission('documents.upload'),
  singleFileUpload,
  documentController.upload,
);
router.get('/', authenticate, requirePermission('documents.view'), documentController.list);
router.get('/:id', authenticate, requirePermission('documents.view'), documentController.getOne);
router.get('/:id/file', authenticate, requirePermission('documents.view'), documentController.download);
router.post(
  '/:id/links',
  authenticate,
  requirePermission('documents.upload'),
  documentController.attach,
);
router.delete(
  '/:id/links/:linkId',
  authenticate,
  requirePermission('documents.upload'),
  documentController.detach,
);
router.delete('/:id', authenticate, requirePermission('documents.delete'), documentController.remove);

export default router;
