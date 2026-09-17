import { Router } from 'express';
import driveRoutes from './driveRoutes.js';

/**
 * Platform integrations, mounted at /api/v1/integrations by routes/index.ts.
 * Not an app's own namespace: an integration's job is to route files to
 * whichever app owns a given purpose (guardrails rule 16), so it belongs to
 * no single app slug — the same reasoning /documents and /ai-usage carry.
 */
const router = Router();

router.use('/drive', driveRoutes);

export default router;
