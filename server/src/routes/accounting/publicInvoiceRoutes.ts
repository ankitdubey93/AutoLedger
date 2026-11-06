import { Router } from 'express';
import * as publicInvoiceController from '../../controllers/accounting/publicInvoiceController.js';
import { publicLinkLimiter } from '../../middleware/rateLimit.js';

/**
 * /api/v1/public/invoices — the emailed invoice link (Phase 48).
 *
 * Deliberately no `authenticate`: the customer has no account. The path
 * token is the credential (looked up by hash, scoped to its org by the
 * service), and every route is rate-limited, successes included. The
 * router-walking permission test skips routes without `authenticate` by
 * design — these are public on purpose.
 */
const router = Router();

router.get('/:token', publicLinkLimiter, publicInvoiceController.view);
router.get('/:token/logo', publicLinkLimiter, publicInvoiceController.logo);
router.get('/:token/pdf', publicLinkLimiter, publicInvoiceController.pdf);
router.post('/:token/payments', publicLinkLimiter, publicInvoiceController.startPayment);
router.post('/:token/payments/:intentId/confirm', publicLinkLimiter, publicInvoiceController.confirmPayment);

export default router;
