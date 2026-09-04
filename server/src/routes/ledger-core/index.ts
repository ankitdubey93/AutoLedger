import { Router } from 'express';
import accountRoutes from './accountRoutes.js';
import billRoutes from './billRoutes.js';
import journalRoutes from './journalRoutes.js';
import paymentRoutes from './paymentRoutes.js';
import reportRoutes from './reportRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import customerRoutes from './customerRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';
import vendorRoutes from './vendorRoutes.js';

/**
 * LedgerCore's router, mounted at /api/v1/ledger-core by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/accounts', accountRoutes);
router.use('/bills', billRoutes);
router.use('/customers', customerRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/journals', journalRoutes);
router.use('/payments', paymentRoutes);
router.use('/reports', reportRoutes);
router.use('/settings', settingsRoutes);
router.use('/vendors', vendorRoutes);

export default router;
