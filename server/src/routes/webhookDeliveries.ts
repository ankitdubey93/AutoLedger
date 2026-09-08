import { Router } from 'express';
import * as webhookDeliveryController from '../controllers/webhookDeliveryController.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

/**
 * /api/v1/webhook-deliveries — see docs/api.md.
 *
 * OWNER and ADMIN only, mirroring /webhooks — a delivery log is the record
 * of what left the building and to whom.
 *
 * There is no PUT or DELETE: a delivery is an outbound record of fact.
 * Replay goes through the one sanctioned FSM edge (FAILED -> PENDING),
 * never a direct mutation.
 */
const router = Router();

router.get('/', authenticate, requireRole('OWNER', 'ADMIN'), webhookDeliveryController.list);
router.get('/:id', authenticate, requireRole('OWNER', 'ADMIN'), webhookDeliveryController.getOne);
router.post('/:id/retry', authenticate, requireRole('OWNER', 'ADMIN'), webhookDeliveryController.retry);

export default router;
