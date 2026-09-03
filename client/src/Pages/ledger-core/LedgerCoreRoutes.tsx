import { Navigate, Route, Routes } from 'react-router-dom';
import LedgerCoreSidebar from './LedgerCoreSidebar';
import { LedgerSettingsProvider, useLedgerSettings } from './LedgerSettingsContext';
import DashboardPage from './DashboardPage';
import AccountsPage from './AccountsPage';
import JournalEntryPage from './JournalEntryPage';
import TrialBalancePage from './TrialBalancePage';
import ReportsPage from './ReportsPage';
import SettingsPage from './SettingsPage';
import OnboardingPage from './OnboardingPage';

/**
 * LedgerCore's own routes, rendered inside AppShell's outlet.
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
 * matching the relative-path pattern the rest of this router already uses
 * (see the old `<Route path="*" element={<Navigate to="" replace />} />`).
 *
 * `PlatformLayout`'s `key={org.id}-${orgVersion}` remounts this entire
 * subtree on every organization switch — that is load-bearing here, not
 * incidental: it is what makes switching into a not-yet-onboarded
 * organization correctly show the wizard again. Do not "optimise" it away.
 */

function AppPages() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[13rem_1fr] gap-6">
      <LedgerCoreSidebar />
      <div className="min-w-0">
        <Routes>
          <Route index element={<DashboardPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="journals" element={<JournalEntryPage />} />
          <Route path="trial-balance" element={<TrialBalancePage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {/* An unknown LedgerCore subpath returns to the dashboard, not the 404 page. */}
          <Route path="*" element={<Navigate to="" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function LedgerCoreGate() {
  const settings = useLedgerSettings();

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

  return (
    <Routes>
      <Route
        path="onboarding"
        element={onboarded ? <Navigate to=".." replace /> : <OnboardingPage />}
      />
      <Route path="*" element={onboarded ? <AppPages /> : <Navigate to="onboarding" replace />} />
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
