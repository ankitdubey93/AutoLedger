import { Router } from 'express';
import * as aiUsageController from '../controllers/aiUsageController.js';
import { authenticate } from '../middleware/auth.js';

/**
 * /api/v1/ai-usage — see docs/api.md.
 *
 * Open to every member, unlike /audit-logs. The audit trail is a control
 * surface — a record of who did what, including what an ACCOUNTANT did —
 * so it is OWNER/ADMIN only. Token spend is operational telemetry about the
 * organization's own processing, the same class of thing /ledger-core/reports
 * is, and every member may read those.
 *
 * There is no write route on this resource, now or ever: rows are written
 * only by aiUsageService.recordCall, called from inside a service.
 */
const router = Router();

router.get('/', authenticate, aiUsageController.summary);

export default router;
