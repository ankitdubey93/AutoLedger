import { Router } from 'express';
import cohortRoutes from './cohortRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import unitEconomicsRoutes from './unitEconomicsRoutes.js';
import productLineRoutes from './productLineRoutes.js';
import pvmRoutes from './pvmRoutes.js';

/**
 * UnitEcon's router, mounted at /api/v1/unitecon by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/cohorts', cohortRoutes);
router.use('/settings', settingsRoutes);
router.use('/unit-economics', unitEconomicsRoutes);
router.use('/product-lines', productLineRoutes);
router.use('/pvm', pvmRoutes);

export default router;
