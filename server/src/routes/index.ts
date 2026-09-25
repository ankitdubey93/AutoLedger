import { Router } from 'express';
import healthRoutes from './health.js';
import authRoutes from './auth.js';
import organizationRoutes from './organizations.js';
import auditRoutes from './auditLogs.js';
import aiUsageRoutes from './aiUsage.js';
import webhookRoutes from './webhooks.js';
import webhookDeliveryRoutes from './webhookDeliveries.js';
import onboardingRoutes from './onboarding.js';
import documentRoutes from './documents.js';
import integrationRoutes from './integrations/index.js';
import accountingRoutes from './accounting/index.js';
import captureRoutes from './capture/index.js';
import inventoryRoutes from './inventory/index.js';

/**
 * The versioned API router. Every module mounts here, never directly on the
 * app, so `/api/v1` is stated in exactly one place and a future `/api/v2` is a
 * second router beside this one rather than an edit to every route file.
 *
 * AutoLedger is one product (Phase 33), so its resources sit directly under
 * /api/v1: `/invoices`, `/bills`, `/accounts`… Two modules keep a prefix
 * because their resource names would otherwise collide with accounting's
 * or the platform's: inventory (`/inventory/items`, `/inventory/settings`)
 * and capture (`/capture/documents`, beside the vault's `/documents`).
 * Before Phase 33 every app had its own prefix (`/ledger-core`, `/stock`,
 * `/ap-flow`); see docs/architecture.md.
 *
 * Module mounts land in phase order — see docs/roadmap.md.
 */
const apiRouter = Router();

apiRouter.use('/health', healthRoutes);

// Phase 1 — identity + tenancy.
apiRouter.use('/auth', authRoutes);
apiRouter.use('/organizations', organizationRoutes);

// Phase 5 — the shared CDC audit trail. Platform-level: it spans every app,
// and `app_slug` on the row carries the namespace (guardrails rule 16, module boundaries).
apiRouter.use('/audit-logs', auditRoutes);

// Phase 7 — outbound financial-event webhooks. Platform-level: any app may
// emit into the outbox, and `app_slug` on the event row carries the
// namespace (guardrails rule 16, module boundaries), exactly as /audit-logs does.
apiRouter.use('/webhooks', webhookRoutes);
apiRouter.use('/webhook-deliveries', webhookDeliveryRoutes);

// Phase 9 — resumable, skippable onboarding state. Platform-level: every app
// that acquires a setup wizard gets skip-and-resume for free, and `app_slug`
// on the row carries the namespace (guardrails rule 16, module boundaries), as /audit-logs does.
apiRouter.use('/onboarding', onboardingRoutes);

// Phase 9.5 — the Document Vault. Platform-level, not namespaced under an
// app: Accounting attaching a PDF and Capture attaching a source image are
// both apps talking to the platform, and `app_slug` on the link row carries
// the namespace (guardrails rule 16, module boundaries), exactly as /audit-logs does.
apiRouter.use('/documents', documentRoutes);

// Phase 19.1 — AI token and cost metering. Platform-level: every app that
// calls a model records here, and `app_slug` on the row carries the
// namespace (guardrails rule 16, module boundaries), exactly as /audit-logs does.
apiRouter.use('/ai-usage', aiUsageRoutes);

// Phase 19.3 — Drive folder intake. Platform-level: a folder's purpose
// routes its files to the owning app through that app's own service
// (guardrails rule 16, module boundaries), so this belongs to no single app slug.
apiRouter.use('/integrations', integrationRoutes);

// --- Module routers ---
// Inventory and capture first: accounting is mounted at the root, and its
// routers claim only their own paths, so the order matters only for
// readability. Anything no router claims falls through to the 404 handler.

// Phase 28 — inventory (was Inventory's /stock).
apiRouter.use('/inventory', inventoryRoutes);

// Phase 10 — capture, the bill inbox (was Capture's /ap-flow).
apiRouter.use('/capture', captureRoutes);

// Phase 3 — accounting, the general ledger (was Accounting's /ledger-core).
apiRouter.use('/', accountingRoutes);

export default apiRouter;
