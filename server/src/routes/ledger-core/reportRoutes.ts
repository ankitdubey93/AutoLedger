import { Router } from 'express';
import * as reportController from '../../controllers/ledger-core/reportController.js';
import { authenticate } from '../../middleware/auth.js';

/**
 * /api/v1/ledger-core/reports — see docs/api.md.
 *
 * Not role-gated beyond membership: a VIEWER exists precisely to read reports.
 * Every figure is aggregated from raw ledger lines on request — there is no
 * summary table to fall out of date.
 */
const router = Router();

router.get('/trial-balance', authenticate, reportController.trialBalance);
router.get('/profit-and-loss', authenticate, reportController.profitAndLoss);
router.get('/balance-sheet', authenticate, reportController.balanceSheet);
router.get('/dashboard', authenticate, reportController.dashboard);
router.get('/ar-aging', authenticate, reportController.arAging);
router.get('/ap-aging', authenticate, reportController.apAging);

export default router;
