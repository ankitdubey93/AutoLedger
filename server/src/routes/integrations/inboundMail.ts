import { Router } from 'express';
import * as inboundMailController from '../../controllers/integrations/inboundMailController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/integrations/inbound-mail — an organization's email-in address for
 * the bill inbox (Phase 43d). Read needs `capture.view`; generating a new
 * address (which retires the old one) needs `capture.process`.
 */
const router = Router();

router.get('/', authenticate, requirePermission('capture.view'), inboundMailController.getAddress);
router.post('/rotate', authenticate, requirePermission('capture.process'), inboundMailController.rotate);
router.get('/messages', authenticate, requirePermission('capture.view'), inboundMailController.listMessages);

export default router;

/**
 * /api/v1/public/inbound-mail — Brevo's webhook (Phase 43d).
 *
 * Public by necessity: Brevo calls it, with no session. Like the Stripe
 * webhook it carries no `authenticate`, so the router-walking permission test
 * (routePermissions.test.ts, which only inspects routes whose stack contains
 * `authenticate`) does not apply — the credential is the secret path segment,
 * compared in constant time. Not rate-limited: a wrong secret costs one
 * buffer comparison, and throttling the provider's retries only delays mail.
 */
export const publicInboundMailRoutes = Router();

publicInboundMailRoutes.post('/brevo/:secret', inboundMailController.brevoWebhook);
