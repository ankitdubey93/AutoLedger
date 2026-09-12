import { Router } from 'express';
import corpusRoutes from './corpusRoutes.js';
import questionRoutes from './questionRoutes.js';

/**
 * TaxGuard AI's router, mounted at /api/v1/taxguard by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/corpus', corpusRoutes);
router.use('/questions', questionRoutes);

export default router;
