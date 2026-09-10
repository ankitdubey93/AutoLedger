import { Router } from 'express';
import * as documentController from '../controllers/documentController.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { singleFileUpload } from '../middleware/upload.js';

/**
 * /api/v1/documents — see docs/api.md.
 *
 * Read is open to every member including VIEWER; writing a file or a link
 * needs ACCOUNTANT and above; destroying a document needs ADMIN and above.
 *
 * `singleFileUpload` runs AFTER `requireRole` on the upload route, so a
 * VIEWER's oversized body is rejected before it is ever buffered into
 * memory.
 */
const router = Router();

router.post(
  '/',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  singleFileUpload,
  documentController.upload,
);
router.get('/', authenticate, documentController.list);
router.get('/:id', authenticate, documentController.getOne);
router.get('/:id/file', authenticate, documentController.download);
router.post(
  '/:id/links',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  documentController.attach,
);
router.delete(
  '/:id/links/:linkId',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  documentController.detach,
);
router.delete('/:id', authenticate, requireRole('OWNER', 'ADMIN'), documentController.remove);

export default router;
