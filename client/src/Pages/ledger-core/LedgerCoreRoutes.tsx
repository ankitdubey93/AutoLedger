import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import LedgerCoreSidebar from './LedgerCoreSidebar';
import { LedgerSettingsProvider, useLedgerSettings } from './LedgerSettingsContext';
import OnboardingBanner from './OnboardingBanner';
import { getOnboardingState, type OnboardingStatus } from '../../services/fetchServices';
import DashboardPage from './DashboardPage';
import AccountsPage from './AccountsPage';
import AccountLedgerPage from './AccountLedgerPage';
import JournalsPage from './JournalsPage';
import NewJournalEntryPage from './NewJournalEntryPage';
import JournalDetailPage from './JournalDetailPage';
import TrialBalancePage from './TrialBalancePage';
import ReportsPage from './ReportsPage';
import ProfitAndLossPage from './ProfitAndLossPage';
import BalanceSheetPage from './BalanceSheetPage';
import FiscalPeriodsPage from './FiscalPeriodsPage';
import SettingsPage from './SettingsPage';
import OnboardingPage from './OnboardingPage';
import InvoicesPage from './InvoicesPage';
import NewInvoicePage from './NewInvoicePage';
import InvoiceDetailPage from './InvoiceDetailPage';
import CustomersPage from './CustomersPage';
import InvoiceSettingsPage from './InvoiceSettingsPage';
import VendorsPage from './VendorsPage';
import BillsPage from './BillsPage';
import NewBillPage from './NewBillPage';
import BillDetailPage from './BillDetailPage';
import PaymentsPage from './PaymentsPage';
import AuditLogPage from './AuditLogPage';
import BankTransactionsPage from './BankTransactionsPage';
import BankImportPage from './BankImportPage';
import BankReconciliationPage from './BankReconciliationPage';
import WebhooksPage from './WebhooksPage';
import WebhookDeliveriesPage from './WebhookDeliveriesPage';
import FxRatesPage from './FxRatesPage';
import FxExposurePage from './FxExposurePage';
import FxRevaluationsPage from './FxRevaluationsPage';
import MigrationImportsPage from './MigrationImportsPage';
import NewMigrationImportPage from './NewMigrationImportPage';
import MigrationImportDetailPage from './MigrationImportDetailPage';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * LedgerCore's own routes, rendered inside AppFrame's outlet.
 *
 * An app owns its internal routing rather than registering every page in
 * App.tsx: the platform router knows that `/app/ledger-core/*` belongs to
 * LedgerCore and nothing more, which is the routing equivalent of the app
 * boundary the server enforces (guardrails rule 16).
 *
 * Phase 3.5 replaces the flat tab strip with a sidebar and adds an onboarding
 * gate: a fresh organization is redirected to `onboarding` until it completes
 * the wizard once, and `onboarding` itself redirects back to the dashboard
 * once it has. Every redirect is a `<Navigate>` inside an actual `<Route>`,
 * and every target is an absolute path from `useAppBasePath()`. Relative
 * targets were a bug: `to=""` and `to="onboarding"` resolve against the
 * splat match's full pathname, so the catch-all redirected to itself and the
 * onboarding gate appended `/onboarding` forever — both infinite loops.
 *
 * `AppFrame`'s `key={org.id}-${orgVersion}` remounts this entire
 * subtree on every organization switch — that is load-bearing here, not
 * incidental: it is what makes switching into a not-yet-onboarded
 * organization correctly show the wizard again. Do not "optimise" it away.
 *
 * Phase 9a makes the gate SOFT: a wizard that was explicitly skipped
 * (onboarding_states.status === 'SKIPPED') no longer forces the redirect —
 * every route stays reachable behind a persistent `OnboardingBanner`
 * instead. Only NOT_STARTED / IN_PROGRESS still redirect.
 */

function AppPages({ showBanner }: { showBanner: boolean }) {
  const base = useAppBasePath();
  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <LedgerCoreSidebar />
      <div className="min-w-0 flex-1 py-6 max-w-[76rem]">
        {showBanner && <OnboardingBanner />}
        <Routes>
          <Route index element={<DashboardPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="accounts/:accountId" element={<AccountLedgerPage />} />
          <Route path="journals" element={<JournalsPage />} />
          <Route path="journals/new" element={<NewJournalEntryPage />} />
          <Route path="journals/:entryId" element={<JournalDetailPage />} />
          <Route path="trial-balance" element={<TrialBalancePage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="reports/profit-and-loss" element={<ProfitAndLossPage />} />
          <Route path="reports/balance-sheet" element={<BalanceSheetPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="invoices/new" element={<NewInvoicePage />} />
          <Route path="invoices/:invoiceId" element={<InvoiceDetailPage />} />
          <Route path="invoices/:invoiceId/edit" element={<NewInvoicePage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="vendors" element={<VendorsPage />} />
          <Route path="bills" element={<BillsPage />} />
          <Route path="bills/new" element={<NewBillPage />} />
          <Route path="bills/:billId" element={<BillDetailPage />} />
          <Route path="bills/:billId/edit" element={<NewBillPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="bank" element={<BankTransactionsPage />} />
          <Route path="bank/import" element={<BankImportPage />} />
          <Route path="bank/reconciliation" element={<BankReconciliationPage />} />
          <Route path="audit" element={<AuditLogPage />} />
          <Route path="webhooks" element={<WebhooksPage />} />
          <Route path="webhooks/deliveries" element={<WebhookDeliveriesPage />} />
          <Route path="fx-rates" element={<FxRatesPage />} />
          <Route path="fx-exposure" element={<FxExposurePage />} />
          <Route path="fx-revaluations" element={<FxRevaluationsPage />} />
          <Route path="fiscal-periods" element={<FiscalPeriodsPage />} />
          <Route path="migration-imports" element={<MigrationImportsPage />} />
          <Route path="migration-imports/new" element={<NewMigrationImportPage />} />
          <Route path="migration-imports/:importId" element={<MigrationImportDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/invoicing" element={<InvoiceSettingsPage />} />
          {/* An unknown LedgerCore subpath returns to the dashboard, not the 404 page. */}
          <Route path="*" element={<Navigate to={base} replace />} />
        </Routes>
      </div>
    </div>
  );
}

function LedgerCoreGate() {
  const settings = useLedgerSettings();
  const base = useAppBasePath();

  // Only needed once settings say "not onboarded" — a skipped wizard is the
  // one case where the gate must NOT redirect, so its status decides that.
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | 'loading'>('loading');

  useEffect(() => {
    if (settings.status !== 'ready' || settings.settings.onboardedAt !== null) return;
    let ignore = false;

    getOnboardingState('ledger-core')
      .then((state) => {
        if (!ignore) setOnboardingStatus(state.status);
      })
      .catch(() => {
        // Unknown — treat as NOT_STARTED, which keeps the existing (hard)
        // redirect behaviour rather than silently unlocking every route.
        if (!ignore) setOnboardingStatus('NOT_STARTED');
      });

    return () => {
      ignore = true;
    };
  }, [settings.status, settings.status === 'ready' ? settings.settings.onboardedAt : null]);

  if (settings.status === 'loading') {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading LedgerCore…</span>
      </div>
    );
  }

  if (settings.status === 'error') {
    return <p className="status status--bad">{settings.message}</p>;
  }

  const onboarded = settings.settings.onboardedAt !== null;
  const skipped = !onboarded && onboardingStatus === 'SKIPPED';
  // Only the catch-all route's decision needs onboardingStatus — the wizard
  // itself (the `onboarding` route below) never did, and gating its render
  // behind this second fetch too was needless latency on every mount of a
  // not-yet-onboarded organization.
  const catchAllLoading = !onboarded && onboardingStatus === 'loading';

  return (
    <Routes>
      <Route
        path="onboarding"
        element={onboarded ? <Navigate to={base} replace /> : <OnboardingPage />}
      />
      <Route
        path="*"
        element={
          onboarded || skipped ? (
            <AppPages showBanner={skipped} />
          ) : catchAllLoading ? (
            <div className="shell" aria-busy="true">
              <div className="skeleton skeleton--title" />
              <span className="visually-hidden">Loading LedgerCore…</span>
            </div>
          ) : (
            <Navigate to={`${base}/onboarding`} replace />
          )
        }
      />
    </Routes>
  );
}

export default function LedgerCoreRoutes() {
  return (
    <LedgerSettingsProvider>
      <LedgerCoreGate />
    </LedgerSettingsProvider>
  );
}
