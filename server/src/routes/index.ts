import { Router } from 'express';
import healthRoutes from './health.js';
import authRoutes from './auth.js';
import organizationRoutes from './organizations.js';
import appRoutes from './apps.js';
import auditRoutes from './auditLogs.js';
import webhookRoutes from './webhooks.js';
import webhookDeliveryRoutes from './webhookDeliveries.js';
import ledgerCoreRoutes from './ledger-core/index.js';

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

// Phase 5 — the shared CDC audit trail. Platform-level: it spans every app,
// and `app_slug` on the row carries the namespace (guardrails rule 16).
apiRouter.use('/audit-logs', auditRoutes);

// Phase 7 — outbound financial-event webhooks. Platform-level: any app may
// emit into the outbox, and `app_slug` on the event row carries the
// namespace (guardrails rule 16), exactly as /audit-logs does.
apiRouter.use('/webhooks', webhookRoutes);
apiRouter.use('/webhook-deliveries', webhookDeliveryRoutes);

// --- App routers ---
// One apiRouter.use('/<slug>', <app>Routes) line per app, added when that
// app's first module ships. The slug must match config/apps.ts.

// Phase 3 — LedgerCore, the general ledger.
apiRouter.use('/ledger-core', ledgerCoreRoutes);

export default apiRouter;
