import { Router } from 'express';
import * as captureDocumentController from '../../controllers/capture/captureDocumentController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { singleFileUpload } from '../../middleware/upload.js';

/**
 * /api/v1/capture/documents — see docs/api.md.
 *
 * Read is open to every member including VIEWER; registering a document or
 * requesting re-extraction needs ACCOUNTANT and above.
 */
const router = Router();

router.post(
  '/',
  authenticate,
  requirePermission('capture.process'),
  captureDocumentController.create,
);
// singleFileUpload runs AFTER requirePermission, matching routes/documents.ts —
// a VIEWER's oversized body is rejected before it is ever buffered.
router.post(
  '/upload',
  authenticate,
  requirePermission('capture.process'),
  singleFileUpload,
  captureDocumentController.upload,
);
router.get('/', authenticate, requirePermission('capture.view'), captureDocumentController.list);
router.get('/:id', authenticate, requirePermission('capture.view'), captureDocumentController.getOne);
router.get('/:id/pages/:pageNumber/image', authenticate, requirePermission('capture.view'), captureDocumentController.pageImage);
router.post(
  '/:id/reextract',
  authenticate,
  requirePermission('capture.process'),
  captureDocumentController.reextract,
);
router.patch(
  '/:id/line-items/:lineId',
  authenticate,
  requirePermission('capture.process'),
  captureDocumentController.updateLineItem,
);
router.post(
  '/:id/post',
  authenticate,
  requirePermission('capture.process'),
  captureDocumentController.post,
);

export default router;
