import { Router } from 'express';
import modelRoutes from './modelRoutes.js';
import scenarioRoutes from './scenarioRoutes.js';

/**
 * FP&A Engine's router, mounted at /api/v1/fpa-engine by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/models', modelRoutes);
router.use('/scenarios', scenarioRoutes);

export default router;
