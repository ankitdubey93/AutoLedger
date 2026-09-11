import { Router } from 'express';
import * as apFlowDocumentController from '../../controllers/ap-flow/apFlowDocumentController.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * /api/v1/ap-flow/review-queue — see docs/api.md. Open to every member
 * including VIEWER, matching GET /documents.
 */
const router = Router();

router.get('/', authenticate, apFlowDocumentController.reviewQueue);

export default router;
