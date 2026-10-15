import { Router } from 'express';
import * as publicQuoteController from '../../controllers/accounting/publicQuoteController.js';
import { publicLinkLimiter } from '../../middleware/rateLimit.js';

/**
 * /api/v1/public/quotes — the emailed quote link (Phase 41).
 *
 * Deliberately no `authenticate`: the recipient has no account. The path
 * token is the credential (looked up by hash, scoped to its org by the
 * service), and every route is rate-limited, successes included. The
 * router-walking permission test skips routes without `authenticate` by
 * design — these are public on purpose.
 */
const router = Router();

router.get('/:token', publicLinkLimiter, publicQuoteController.view);
router.get('/:token/logo', publicLinkLimiter, publicQuoteController.logo);
router.get('/:token/pdf', publicLinkLimiter, publicQuoteController.pdf);
router.post('/:token/accept', publicLinkLimiter, publicQuoteController.accept);
router.post('/:token/verify-email', publicLinkLimiter, publicQuoteController.verifyEmail);
router.post('/:token/decline', publicLinkLimiter, publicQuoteController.decline);

export default router;
