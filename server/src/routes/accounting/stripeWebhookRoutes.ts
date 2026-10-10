import { Router } from 'express';
import * as publicStatementController from '../../controllers/accounting/publicStatementController.js';

/**
 * /api/v1/public/stripe — Stripe's webhook (Phase 39c).
 *
 * Public by necessity: Stripe calls it. The credential is the
 * `Stripe-Signature` HMAC over the raw body, so app.ts mounts
 * `express.raw` for this path ahead of `express.json` — verifying a
 * signature over re-serialised JSON would fail. Not rate-limited: a
 * rejected signature costs one HMAC, and throttling Stripe's retries would
 * only delay settlement.
 */
const router = Router();

router.post('/webhook', publicStatementController.stripeWebhook);

export default router;
