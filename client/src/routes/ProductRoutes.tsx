import { Navigate, Route, Routes } from 'react-router-dom';
import SetupGate, { OnboardingRoute, SettingsRoot } from './SetupGate';
import InventoryGate from './InventoryGate';
import NotFoundPage from '../Pages/NotFoundPage';
// Home
import DashboardPage from '../Pages/home/DashboardPage';
// Sales
import InvoicesPage from '../Pages/sales/InvoicesPage';
import NewInvoicePage from '../Pages/sales/NewInvoicePage';
import InvoiceDetailPage from '../Pages/sales/InvoiceDetailPage';
import CreditNotesPage from '../Pages/sales/CreditNotesPage';
import NewCreditNotePage from '../Pages/sales/NewCreditNotePage';
import CreditNoteDetailPage from '../Pages/sales/CreditNoteDetailPage';
import CustomersPage from '../Pages/sales/CustomersPage';
import PartyAccountPage from '../Pages/sales/PartyAccountPage';
import PaymentsPage from '../Pages/sales/PaymentsPage';
// Purchases
import BillsPage from '../Pages/purchases/BillsPage';
import NewBillPage from '../Pages/purchases/NewBillPage';
import BillDetailPage from '../Pages/purchases/BillDetailPage';
import DebitNotesPage from '../Pages/purchases/DebitNotesPage';
import NewDebitNotePage from '../Pages/purchases/NewDebitNotePage';
import DebitNoteDetailPage from '../Pages/purchases/DebitNoteDetailPage';
import VendorsPage from '../Pages/purchases/VendorsPage';
// Bill inbox
import InboxPage from '../Pages/inbox/InboxPage';
import InboxReviewPage from '../Pages/inbox/InboxReviewPage';
import InboxDocumentPage from '../Pages/inbox/InboxDocumentPage';
// Products & inventory
import ProductsPage from '../Pages/products/ProductsPage';
import InventorySetupPage from '../Pages/inventory/InventorySetupPage';
import InventoryItemsPage from '../Pages/inventory/InventoryItemsPage';
import InventoryNewItemPage from '../Pages/inventory/InventoryNewItemPage';
import InventoryItemDetailPage from '../Pages/inventory/InventoryItemDetailPage';
import InventoryMovementsPage from '../Pages/inventory/InventoryMovementsPage';
import InventoryLocationsPage from '../Pages/inventory/InventoryLocationsPage';
import InventoryLabelsPage from '../Pages/inventory/InventoryLabelsPage';
import InventoryLookupPage from '../Pages/inventory/InventoryLookupPage';
import InventoryScanRedirect from '../Pages/inventory/InventoryScanRedirect';
// Banking
import BankTransactionsPage from '../Pages/banking/BankTransactionsPage';
import BankImportPage from '../Pages/banking/BankImportPage';
import BankReconciliationPage from '../Pages/banking/BankReconciliationPage';
// Accounting
import AccountsPage from '../Pages/accounting/AccountsPage';
import AccountLedgerPage from '../Pages/accounting/AccountLedgerPage';
import JournalsPage from '../Pages/accounting/JournalsPage';
import NewJournalEntryPage from '../Pages/accounting/NewJournalEntryPage';
import JournalDetailPage from '../Pages/accounting/JournalDetailPage';
import FiscalPeriodsPage from '../Pages/accounting/FiscalPeriodsPage';
import FxRatesPage from '../Pages/accounting/FxRatesPage';
import FxExposurePage from '../Pages/accounting/FxExposurePage';
import FxRevaluationsPage from '../Pages/accounting/FxRevaluationsPage';
import MigrationImportsPage from '../Pages/accounting/MigrationImportsPage';
import NewMigrationImportPage from '../Pages/accounting/NewMigrationImportPage';
import MigrationImportDetailPage from '../Pages/accounting/MigrationImportDetailPage';
// Reports
import ReportsPage from '../Pages/reports/ReportsPage';
import ProfitAndLossPage from '../Pages/reports/ProfitAndLossPage';
import BalanceSheetPage from '../Pages/reports/BalanceSheetPage';
import TrialBalancePage from '../Pages/reports/TrialBalancePage';
// Settings
import SettingsHubPage from '../Pages/settings/SettingsHubPage';
import GeneralSettingsPage from '../Pages/settings/GeneralSettingsPage';
import FinancialSettingsPage from '../Pages/settings/FinancialSettingsPage';
import ChartSettingsPage from '../Pages/settings/ChartSettingsPage';
import ConversionBalancesPage from '../Pages/settings/ConversionBalancesPage';
import InvoiceSettingsPage from '../Pages/settings/InvoiceSettingsPage';
import InvoiceTemplatePage from '../Pages/settings/InvoiceTemplatePage';
import PaymentTermsSettingsPage from '../Pages/settings/PaymentTermsSettingsPage';
import InventoryCatalogueSettingsPage from '../Pages/settings/InventoryCatalogueSettingsPage';
import ItemCodesSettingsPage from '../Pages/settings/ItemCodesSettingsPage';
import InboxSettingsPage from '../Pages/settings/InboxSettingsPage';
import AiUsagePage from '../Pages/settings/AiUsagePage';
import ConnectionsPage from '../Pages/settings/ConnectionsPage';
import WebhooksPage from '../Pages/settings/WebhooksPage';
import WebhookDeliveriesPage from '../Pages/settings/WebhookDeliveriesPage';
import AuditLogPage from '../Pages/settings/AuditLogPage';


/**
 * Every product page, behind the setup gate (Phase 33). Mounted by App.tsx
 * under `/*` inside AppShell; tests mount it directly under a MemoryRouter,
 * which is why it is its own component and not inline in App.tsx.
 *
 * Every path is absolute and every link in the product is absolute, so the
 * descendant `<Routes>` resolves nothing relative to the splat.
 */
export default function ProductRoutes() {
  return (
    <Routes>
      <Route element={<SettingsRoot />}>
        <Route path="/onboarding" element={<OnboardingRoute />} />

        <Route element={<SetupGate />}>
          <Route path="/" element={<DashboardPage />} />

          {/* Sales */}
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/new" element={<NewInvoicePage />} />
          <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />
          <Route path="/invoices/:invoiceId/edit" element={<NewInvoicePage />} />
          {/* A new note is always reached from its original document (?invoiceId= / ?billId=). */}
          <Route path="/credit-notes" element={<CreditNotesPage />} />
          <Route path="/credit-notes/new" element={<NewCreditNotePage />} />
          <Route path="/credit-notes/:noteId" element={<CreditNoteDetailPage />} />
          <Route path="/credit-notes/:noteId/edit" element={<NewCreditNotePage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:partyId" element={<PartyAccountPage kind="CUSTOMER" />} />
          <Route path="/payments" element={<PaymentsPage />} />

          {/* Purchases. "Expenses" is the UI label for a bill (Phase 24); /bills/* stays as an alias. */}
          <Route path="/expenses" element={<BillsPage />} />
          <Route path="/expenses/new" element={<NewBillPage />} />
          <Route path="/expenses/:billId" element={<BillDetailPage />} />
          <Route path="/expenses/:billId/edit" element={<NewBillPage />} />
          <Route path="/bills" element={<BillsPage />} />
          <Route path="/bills/new" element={<NewBillPage />} />
          <Route path="/bills/:billId" element={<BillDetailPage />} />
          <Route path="/bills/:billId/edit" element={<NewBillPage />} />
          <Route path="/debit-notes" element={<DebitNotesPage />} />
          <Route path="/debit-notes/new" element={<NewDebitNotePage />} />
          <Route path="/debit-notes/:noteId" element={<DebitNoteDetailPage />} />
          <Route path="/debit-notes/:noteId/edit" element={<NewDebitNotePage />} />
          <Route path="/vendors" element={<VendorsPage />} />
          <Route path="/vendors/:partyId" element={<PartyAccountPage kind="VENDOR" />} />

          {/* Bill inbox. The literal "review" route must precede ":id". */}
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/review" element={<InboxReviewPage />} />
          <Route path="/inbox/:id" element={<InboxDocumentPage />} />

          {/* Products & inventory */}
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/items" element={<Navigate to="/products" replace />} />
          <Route path="/inventory/setup" element={<InventorySetupPage />} />
          <Route element={<InventoryGate />}>
            <Route path="/inventory" element={<Navigate to="/inventory/items" replace />} />
            <Route path="/inventory/items" element={<InventoryItemsPage />} />
            <Route path="/inventory/items/new" element={<InventoryNewItemPage />} />
            <Route path="/inventory/items/:id" element={<InventoryItemDetailPage />} />
            <Route path="/inventory/movements" element={<InventoryMovementsPage />} />
            <Route path="/inventory/locations" element={<InventoryLocationsPage />} />
            <Route path="/inventory/labels" element={<InventoryLabelsPage />} />
            <Route path="/inventory/lookup" element={<InventoryLookupPage />} />
            <Route path="/inventory/scan/:kind/:id" element={<InventoryScanRedirect />} />
            <Route path="/settings/inventory" element={<InventoryCatalogueSettingsPage />} />
            <Route path="/settings/inventory/codes" element={<ItemCodesSettingsPage />} />
          </Route>

          {/* Banking */}
          <Route path="/bank" element={<BankTransactionsPage />} />
          <Route path="/bank/import" element={<BankImportPage />} />
          <Route path="/bank/reconciliation" element={<BankReconciliationPage />} />

          {/* Accounting */}
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:accountId" element={<AccountLedgerPage />} />
          <Route path="/journals" element={<JournalsPage />} />
          <Route path="/journals/new" element={<NewJournalEntryPage />} />
          <Route path="/journals/:entryId" element={<JournalDetailPage />} />
          <Route path="/fiscal-periods" element={<FiscalPeriodsPage />} />
          <Route path="/fx-rates" element={<FxRatesPage />} />
          <Route path="/fx-exposure" element={<FxExposurePage />} />
          <Route path="/fx-revaluations" element={<FxRevaluationsPage />} />
          <Route path="/migration-imports" element={<MigrationImportsPage />} />
          <Route path="/migration-imports/new" element={<NewMigrationImportPage />} />
          <Route path="/migration-imports/:importId" element={<MigrationImportDetailPage />} />

          {/* Reports */}
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/reports/profit-and-loss" element={<ProfitAndLossPage />} />
          <Route path="/reports/balance-sheet" element={<BalanceSheetPage />} />
          <Route path="/trial-balance" element={<TrialBalancePage />} />

          {/* Settings */}
          <Route path="/settings" element={<SettingsHubPage />} />
          <Route path="/settings/general" element={<GeneralSettingsPage />} />
          <Route path="/settings/financial" element={<FinancialSettingsPage />} />
          <Route path="/settings/chart" element={<ChartSettingsPage />} />
          <Route path="/settings/conversion-balances" element={<ConversionBalancesPage />} />
          <Route path="/settings/invoicing" element={<InvoiceSettingsPage />} />
          <Route path="/settings/invoice-template" element={<InvoiceTemplatePage />} />
          <Route path="/settings/payment-terms" element={<PaymentTermsSettingsPage />} />
          <Route path="/settings/inbox" element={<InboxSettingsPage />} />
          <Route path="/settings/ai-usage" element={<AiUsagePage />} />
          <Route path="/settings/connections" element={<ConnectionsPage />} />
          <Route path="/settings/webhooks" element={<WebhooksPage />} />
          <Route path="/settings/webhooks/deliveries" element={<WebhookDeliveriesPage />} />
          <Route path="/settings/audit" element={<AuditLogPage />} />

          {/* Routes retired in Phase 33 */}
          <Route path="/welcome" element={<Navigate to="/" replace />} />
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/integrations" element={<Navigate to="/settings/connections" replace />} />
          <Route path="/audit" element={<Navigate to="/settings/audit" replace />} />
          <Route path="/webhooks" element={<Navigate to="/settings/webhooks" replace />} />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
