import { Router } from 'express';
import * as reportController from '../../controllers/accounting/reportController.js';
import * as glExceptionController from '../../controllers/accounting/glExceptionController.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';

/**
 * /api/v1/reports — see docs/api.md.
 *
 * Not role-gated beyond membership: a VIEWER exists precisely to read reports.
 * Every figure is aggregated from raw ledger lines on request — there is no
 * summary table to fall out of date.
 */
const router = Router();

router.get('/trial-balance', authenticate, requirePermission('reports.view'), reportController.trialBalance);
router.get('/profit-and-loss', authenticate, requirePermission('reports.view'), reportController.profitAndLoss);
router.get(
  '/profit-and-loss/comparison',
  authenticate,
  requirePermission('reports.view'),
  reportController.profitAndLossComparison,
);
router.get('/balance-sheet', authenticate, requirePermission('reports.view'), reportController.balanceSheet);
router.get('/cash-flow', authenticate, requirePermission('reports.view'), reportController.cashFlow);
router.get('/dashboard', authenticate, requirePermission('reports.view'), reportController.dashboard);
router.get('/ar-aging', authenticate, requirePermission('reports.view'), reportController.arAging);
router.get('/ap-aging', authenticate, requirePermission('reports.view'), reportController.apAging);
router.get('/tax-summary', authenticate, requirePermission('reports.view'), reportController.taxSummary);
router.get('/bank-reconciliation', authenticate, requirePermission('reports.view'), reportController.bankReconciliation);
router.get('/fx-exposure', authenticate, requirePermission('reports.view'), reportController.fxExposure);
router.get('/account-transactions', authenticate, requirePermission('reports.view'), reportController.accountTransactions);
router.get('/sales-by-customer', authenticate, requirePermission('reports.view'), reportController.salesPurchases('sales-by-customer'));
router.get('/purchases-by-vendor', authenticate, requirePermission('reports.view'), reportController.salesPurchases('purchases-by-vendor'));
router.get('/sales-by-item', authenticate, requirePermission('reports.view'), reportController.salesPurchases('sales-by-item'));
router.get('/purchases-by-item', authenticate, requirePermission('reports.view'), reportController.salesPurchases('purchases-by-item'));
router.get('/exceptions', authenticate, requirePermission('reports.view'), glExceptionController.list);
router.post(
  '/exceptions/reviews',
  authenticate,
  requirePermission('reports.review_exceptions'),
  glExceptionController.createReview,
);
router.delete(
  '/exceptions/reviews/:id',
  authenticate,
  requirePermission('reports.review_exceptions'),
  glExceptionController.deleteReview,
);

export default router;
