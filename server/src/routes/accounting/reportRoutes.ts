import { Router } from 'express';
import * as reportController from '../../controllers/accounting/reportController.js';
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
router.get('/balance-sheet', authenticate, requirePermission('reports.view'), reportController.balanceSheet);
router.get('/dashboard', authenticate, requirePermission('reports.view'), reportController.dashboard);
router.get('/ar-aging', authenticate, requirePermission('reports.view'), reportController.arAging);
router.get('/ap-aging', authenticate, requirePermission('reports.view'), reportController.apAging);
router.get('/bank-reconciliation', authenticate, requirePermission('reports.view'), reportController.bankReconciliation);
router.get('/fx-exposure', authenticate, requirePermission('reports.view'), reportController.fxExposure);

export default router;
