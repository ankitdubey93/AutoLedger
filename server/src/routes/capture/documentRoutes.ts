import { Router } from 'express';
import * as captureDocumentController from '../../controllers/capture/captureDocumentController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
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
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  captureDocumentController.create,
);
// singleFileUpload runs AFTER requireRole, matching routes/documents.ts —
// a VIEWER's oversized body is rejected before it is ever buffered.
router.post(
  '/upload',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  singleFileUpload,
  captureDocumentController.upload,
);
router.get('/', authenticate, captureDocumentController.list);
router.get('/:id', authenticate, captureDocumentController.getOne);
router.get('/:id/pages/:pageNumber/image', authenticate, captureDocumentController.pageImage);
router.post(
  '/:id/reextract',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  captureDocumentController.reextract,
);
router.patch(
  '/:id/line-items/:lineId',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  captureDocumentController.updateLineItem,
);
router.post(
  '/:id/post',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  captureDocumentController.post,
);

export default router;
