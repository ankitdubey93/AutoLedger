import { Router } from 'express';
import accountRoutes from './accountRoutes.js';
import bankImportRoutes from './bankImportRoutes.js';
import bankRuleRoutes from './bankRuleRoutes.js';
import bankTransactionRoutes from './bankTransactionRoutes.js';
import billRoutes from './billRoutes.js';
import journalRoutes from './journalRoutes.js';
import manualJournalRoutes from './manualJournalRoutes.js';
import paymentRoutes from './paymentRoutes.js';
import reportRoutes from './reportRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import statementRoutes from './statementRoutes.js';
import statementSendRoutes from './statementSendRoutes.js';
import publicStatementRoutes from './publicStatementRoutes.js';
import publicQuoteRoutes from './publicQuoteRoutes.js';
import { buildQuoteRouter } from './quoteRoutes.js';
import { buildOrderRouter } from './orderRoutes.js';
import stripeWebhookRoutes from './stripeWebhookRoutes.js';
import onlinePaymentRoutes from './onlinePaymentRoutes.js';
import creditNoteRoutes from './creditNoteRoutes.js';
import depositRoutes from './depositRoutes.js';
import customerRoutes from './customerRoutes.js';
import debitNoteRoutes from './debitNoteRoutes.js';
import fiscalPeriodRoutes from './fiscalPeriodRoutes.js';
import fxRateRoutes from './fxRateRoutes.js';
import fxRevaluationRoutes from './fxRevaluationRoutes.js';
import invoiceRoutes from './invoiceRoutes.js';
import itemRoutes from './itemRoutes.js';
import migrationImportRoutes from './migrationImportRoutes.js';
import paymentTermRoutes from './paymentTermRoutes.js';
import recurringScheduleRoutes from './recurringScheduleRoutes.js';
import vendorRoutes from './vendorRoutes.js';
import { buildHistoryRouter } from '../historyRoutes.js';

/**
 * Accounting's router, mounted at /api/v1 by routes/index.ts.
 *
 * The slug is a routing namespace, not a tenancy boundary — `org_id` is still
 * the only access-control boundary inside these routes (guardrails rule 16).
 */
const router = Router();

router.use('/accounts', accountRoutes);
router.use('/bank-imports', bankImportRoutes);
router.use('/bank-rules', bankRuleRoutes);
// Phase 46c — History & notes for bank lines. Mounted before the resource router.
router.use('/bank-transactions', buildHistoryRouter('BANK_TRANSACTION', { view: 'bank.view', note: 'bank.reconcile' }));
router.use('/bank-transactions', bankTransactionRoutes);
router.use('/bills', buildHistoryRouter('BILL', { view: 'bills.view', note: 'bills.edit' }));
router.use('/bills', billRoutes);
router.use('/credit-notes', buildHistoryRouter('CREDIT_NOTE', { view: 'credit_notes.view', note: 'credit_notes.edit' }));
router.use('/credit-notes', creditNoteRoutes);
router.use('/customers', buildHistoryRouter('CUSTOMER', { view: 'customers.view', note: 'customers.manage' }));
router.use('/customers', customerRoutes);
router.use('/debit-notes', buildHistoryRouter('DEBIT_NOTE', { view: 'debit_notes.view', note: 'debit_notes.edit' }));
router.use('/debit-notes', debitNoteRoutes);
// Phase 42 — deposit applications (voids only; applying is on invoices and bills).
router.use('/deposit-applications', depositRoutes);
router.use('/fiscal-periods', fiscalPeriodRoutes);
router.use('/fx-rates', fxRateRoutes);
router.use('/fx-revaluations', fxRevaluationRoutes);
router.use('/invoices', buildHistoryRouter('INVOICE', { view: 'invoices.view', note: 'invoices.edit' }));
router.use('/invoices', invoiceRoutes);
// Phase 41 — quotes, one router per direction.
router.use('/quotes', buildHistoryRouter('QUOTE', { view: 'quotes.view', note: 'quotes.edit' }));
router.use('/quotes', buildQuoteRouter('SALES'));
router.use('/purchase-quotes', buildHistoryRouter('PURCHASE_QUOTE', { view: 'purchase_quotes.view', note: 'purchase_quotes.edit' }));
router.use('/purchase-quotes', buildQuoteRouter('PURCHASE'));
// Phase 42 — sales and purchase orders, one router per direction.
router.use('/orders', buildHistoryRouter('SALES_ORDER', { view: 'sales_orders.view', note: 'sales_orders.edit' }));
router.use('/orders', buildOrderRouter('SALES'));
router.use('/purchase-orders', buildHistoryRouter('PURCHASE_ORDER', { view: 'purchase_orders.view', note: 'purchase_orders.edit' }));
router.use('/purchase-orders', buildOrderRouter('PURCHASE'));
router.use('/items', itemRoutes);
router.use('/journals', journalRoutes);
router.use('/manual-journals', buildHistoryRouter('MANUAL_JOURNAL', { view: 'journals.view', note: 'journals.create' }));
router.use('/manual-journals', manualJournalRoutes);
router.use('/migration-imports', migrationImportRoutes);
router.use('/payments', buildHistoryRouter('PAYMENT', { view: 'payments.view', note: 'payments.create' }));
router.use('/payments', paymentRoutes);
router.use('/payment-terms', paymentTermRoutes);
router.use('/recurring-schedules', recurringScheduleRoutes);
router.use('/reports', reportRoutes);
router.use('/settings', settingsRoutes);
router.use('/statements', statementRoutes);
router.use('/statement-sends', statementSendRoutes);
// Phase 39b — unauthenticated, token-scoped. See publicStatementRoutes.ts.
router.use('/public/statements', publicStatementRoutes);
// Phase 41 — unauthenticated, token-scoped. See publicQuoteRoutes.ts.
router.use('/public/quotes', publicQuoteRoutes);
router.use('/public/stripe', stripeWebhookRoutes);
router.use('/online-payments', onlinePaymentRoutes);
router.use('/vendors', buildHistoryRouter('VENDOR', { view: 'vendors.view', note: 'vendors.manage' }));
router.use('/vendors', vendorRoutes);

export default router;
