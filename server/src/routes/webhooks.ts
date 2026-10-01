import { Router } from 'express';
import * as webhookController from '../controllers/webhookController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

/**
 * /api/v1/webhooks — see docs/api.md.
 *
 * OWNER and ADMIN configure endpoints, mirroring /audit-logs, because a
 * webhook URL is a control surface that moves financial data out of the
 * building. Destroying delivery history (DELETE) and reissuing a signing
 * key (rotate-secret) are OWNER-only — both are irreversible and neither is
 * a bookkeeping action. ACCOUNTANT gets nothing here.
 */
const router = Router();

router.get('/', authenticate, requirePermission('webhooks.manage'), webhookController.list);
router.post('/', authenticate, requirePermission('webhooks.manage'), webhookController.create);
router.get('/:id', authenticate, requirePermission('webhooks.manage'), webhookController.getOne);
router.patch('/:id', authenticate, requirePermission('webhooks.manage'), webhookController.update);
router.delete('/:id', authenticate, requirePermission('webhooks.secrets'), webhookController.remove);
router.post('/:id/rotate-secret', authenticate, requirePermission('webhooks.secrets'), webhookController.rotate);

export default router;
