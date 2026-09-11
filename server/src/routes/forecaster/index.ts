import { Router } from 'express';
import planRoutes from './planRoutes.js';
import driverRoutes from './driverRoutes.js';
import headcountRoutes from './headcountRoutes.js';
import forecastLineRoutes from './forecastLineRoutes.js';
import budgetRoutes from './budgetRoutes.js';
import budgetLineRoutes from './budgetLineRoutes.js';

/**
 * ForecasterPro's router, mounted at /api/v1/forecaster by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/plans', planRoutes);
router.use('/drivers', driverRoutes);
router.use('/headcount', headcountRoutes);
router.use('/forecast-lines', forecastLineRoutes);
router.use('/budget-versions', budgetRoutes);
router.use('/budget-lines', budgetLineRoutes);

export default router;
