import { Router } from 'express';
import * as apFlowDocumentController from '../../controllers/ap-flow/apFlowDocumentController.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

/**
 * /api/v1/ap-flow/documents — see docs/api.md.
 *
 * Read is open to every member including VIEWER; registering a document or
 * requesting re-extraction needs ACCOUNTANT and above.
 */
const router = Router();

router.post(
  '/',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  apFlowDocumentController.create,
);
router.get('/', authenticate, apFlowDocumentController.list);
router.get('/:id', authenticate, apFlowDocumentController.getOne);
router.get('/:id/pages/:pageNumber/image', authenticate, apFlowDocumentController.pageImage);
router.post(
  '/:id/reextract',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  apFlowDocumentController.reextract,
);
router.patch(
  '/:id/line-items/:lineId',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  apFlowDocumentController.updateLineItem,
);
router.post(
  '/:id/post',
  authenticate,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  apFlowDocumentController.post,
);

export default router;
