import { Router } from 'express';
import healthRoutes from './health.js';
import authRoutes from './auth.js';
import organizationRoutes from './organizations.js';
import appRoutes from './apps.js';
import auditRoutes from './auditLogs.js';
import webhookRoutes from './webhooks.js';
import webhookDeliveryRoutes from './webhookDeliveries.js';
import onboardingRoutes from './onboarding.js';
import documentRoutes from './documents.js';
import ledgerCoreRoutes from './ledger-core/index.js';
import apFlowRoutes from './ap-flow/index.js';
import fpaEngineRoutes from './fpa-engine/index.js';
import forecasterRoutes from './forecaster/index.js';
import uniteconRoutes from './unitecon/index.js';
import boarddeckRoutes from './boarddeck/index.js';
import taxguardRoutes from './taxguard/index.js';

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

// Phase 9 — resumable, skippable onboarding state. Platform-level: every app
// that acquires a setup wizard gets skip-and-resume for free, and `app_slug`
// on the row carries the namespace (guardrails rule 16), as /audit-logs does.
apiRouter.use('/onboarding', onboardingRoutes);

// Phase 9.5 — the Document Vault. Platform-level, not namespaced under an
// app: LedgerCore attaching a PDF and AP-Flow attaching a source image are
// both apps talking to the platform, and `app_slug` on the link row carries
// the namespace (guardrails rule 16), exactly as /audit-logs does.
apiRouter.use('/documents', documentRoutes);

// --- App routers ---
// One apiRouter.use('/<slug>', <app>Routes) line per app, added when that
// app's first module ships. The slug must match config/apps.ts.

// Phase 3 — LedgerCore, the general ledger.
apiRouter.use('/ledger-core', ledgerCoreRoutes);

// Phase 10 — AP-Flow, invoice capture & extraction.
apiRouter.use('/ap-flow', apFlowRoutes);

// Phase 12 — FP&A Engine, the linked 3-statement model.
apiRouter.use('/fpa-engine', fpaEngineRoutes);

// Phase 13 — ForecasterPro, driver-based rolling forecasting.
apiRouter.use('/forecaster', forecasterRoutes);

// Phase 14 — UnitEcon, cohort retention and unit economics.
apiRouter.use('/unitecon', uniteconRoutes);

// Phase 15 — BoardDeck Automator, close automation and board reporting.
apiRouter.use('/boarddeck', boarddeckRoutes);

// Phase 16 — TaxGuard AI, tax act parsing and RAG over pgvector.
apiRouter.use('/taxguard', taxguardRoutes);

export default apiRouter;
