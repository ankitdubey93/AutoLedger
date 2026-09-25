import { Router } from 'express';
import accountRoutes from './accountRoutes.js';
import bankImportRoutes from './bankImportRoutes.js';
import bankTransactionRoutes from './bankTransactionRoutes.js';
import billRoutes from './billRoutes.js';
import journalRoutes from './journalRoutes.js';
import paymentRoutes from './paymentRoutes.js';
import reportRoutes from './reportRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import creditNoteRoutes from './creditNoteRoutes.js';
import customerRoutes from './customerRoutes.js';
import debitNoteRoutes from './debitNoteRoutes.js';
import fiscalPeriodRoutes from './fiscalPeriodRoutes.js';
import fxRateRoutes from './fxRateRoutes.js';
import fxRevaluationRoutes from './fxRevaluationRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';
import itemRoutes from './itemRoutes.js';
import migrationImportRoutes from './migrationImportRoutes.js';
import paymentTermRoutes from './paymentTermRoutes.js';
import vendorRoutes from './vendorRoutes.js';

/**
 * Accounting's router, mounted at /api/v1 by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/accounts', accountRoutes);
router.use('/bank-imports', bankImportRoutes);
router.use('/bank-transactions', bankTransactionRoutes);
router.use('/bills', billRoutes);
router.use('/credit-notes', creditNoteRoutes);
router.use('/customers', customerRoutes);
router.use('/debit-notes', debitNoteRoutes);
router.use('/fiscal-periods', fiscalPeriodRoutes);
router.use('/fx-rates', fxRateRoutes);
router.use('/fx-revaluations', fxRevaluationRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/items', itemRoutes);
router.use('/journals', journalRoutes);
router.use('/migration-imports', migrationImportRoutes);
router.use('/payments', paymentRoutes);
router.use('/payment-terms', paymentTermRoutes);
router.use('/reports', reportRoutes);
router.use('/settings', settingsRoutes);
router.use('/vendors', vendorRoutes);

export default router;
