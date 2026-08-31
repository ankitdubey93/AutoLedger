import { Router } from 'express';
import healthRoutes from './health.js';
import authRoutes from './auth.js';
import organizationRoutes from './organizations.js';
import appRoutes from './apps.js';

/**
 * The versioned API router. Every module mounts here, never directly on the
 * app, so `/api/v1` is stated in exactly one place and a future `/api/v2` is a
 * second router beside this one rather than an edit to every route file.
 *
 * Platform routes (auth, organizations, apps, health) are app-less. Each
 * portfolio app mounts below them at /api/v1/<app-slug> — see
 * docs/architecture.md#suite-structure and config/apps.ts for the slugs.
 *
 * Module mounts land in phase order — see docs/roadmap.md.
 */
const apiRouter = Router();

apiRouter.use('/health', healthRoutes);

// Phase 1 — identity + tenancy.
apiRouter.use('/auth', authRoutes);
apiRouter.use('/organizations', organizationRoutes);

// Phase 2 — the app registry.
apiRouter.use('/apps', appRoutes);

// --- App routers ---
// One apiRouter.use('/<slug>', <app>Routes) line per app, added when that
// app's first module ships. None yet — LedgerCore is the first, in Phase 3.

export default apiRouter;
