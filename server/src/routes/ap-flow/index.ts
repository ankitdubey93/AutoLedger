import { Router } from 'express';
import documentRoutes from './documentRoutes.js';
import reviewRoutes from './reviewRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import driveRoutes from './driveRoutes.js';

/**
 * AP-Flow's router, mounted at /api/v1/ap-flow by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/settings', settingsRoutes);
router.use('/review-queue', reviewRoutes);
router.use('/documents', documentRoutes);
router.use('/drive', driveRoutes);

export default router;
