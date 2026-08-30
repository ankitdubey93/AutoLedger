import { Router } from 'express';
import healthRoutes from './health.js';
import authRoutes from './auth.js';
import organizationRoutes from './organizations.js';

/**
 * The versioned API router. Every module mounts here, never directly on the
 * app, so `/api/v1` is stated in exactly one place and a future `/api/v2` is a
 * second router beside this one rather than an edit to every route file.
 *
 * Module mounts land in phase order — see docs/roadmap.md.
 */
const apiRouter = Router();

apiRouter.use('/health', healthRoutes);

// Phase 1 — identity + tenancy.
apiRouter.use('/auth', authRoutes);
apiRouter.use('/organizations', organizationRoutes);

export default apiRouter;
