import { Router } from 'express';
import accountRoutes from './accountRoutes.js';
import journalRoutes from './journalRoutes.js';
import reportRoutes from './reportRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import customerRoutes from './customerRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';

/**
 * LedgerCore's router, mounted at /api/v1/ledger-core by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/accounts', accountRoutes);
router.use('/customers', customerRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/journals', journalRoutes);
router.use('/reports', reportRoutes);
router.use('/settings', settingsRoutes);

export default router;
