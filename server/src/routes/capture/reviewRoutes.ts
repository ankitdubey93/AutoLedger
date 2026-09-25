import { Router } from 'express';
import * as captureDocumentController from '../../controllers/capture/captureDocumentController.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * /api/v1/capture/review-queue — see docs/api.md. Open to every member
 * including VIEWER, matching GET /documents.
 */
const router = Router();

router.get('/', authenticate, captureDocumentController.reviewQueue);

export default router;
