import { Router } from 'express';
import * as statementEmailController from '../../controllers/accounting/statementEmailController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/** /api/v1/statement-sends — an emailed statement's link (Phase 39b). */
const router = Router();

router.post('/:id/revoke', authenticate, requirePermission('statements.send'), statementEmailController.revokeSend);

export default router;
