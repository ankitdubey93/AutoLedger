import { Router } from 'express';
import * as publicStatementController from '../../controllers/accounting/publicStatementController.js';
import { publicLinkLimiter } from '../../middleware/rateLimit.js';

/**
 * /api/v1/public/statements — the emailed statement link (Phase 39b).
 *
 * Deliberately no `authenticate`: the customer has no account. The path
 * token is the credential (looked up by hash, scoped to its org by the
 * service), and every route is rate-limited, successes included. The
 * router-walking permission test skips routes without `authenticate` by
 * design — these are public on purpose.
 */
const router = Router();

router.get('/:token', publicLinkLimiter, publicStatementController.view);
router.get('/:token/logo', publicLinkLimiter, publicStatementController.logo);
// Phase 39c — card payment.
router.post('/:token/payments', publicLinkLimiter, publicStatementController.startPayment);
router.post('/:token/payments/:intentId/confirm', publicLinkLimiter, publicStatementController.confirmPayment);

export default router;
