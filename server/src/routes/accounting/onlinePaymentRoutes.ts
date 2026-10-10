import { Router } from 'express';
import * as onlinePaymentController from '../../controllers/accounting/onlinePaymentController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/** /api/v1/online-payments — card payments made from statement links (Phase 39c). */
const router = Router();

router.get('/', authenticate, requirePermission('payments.view'), onlinePaymentController.list);

export default router;
