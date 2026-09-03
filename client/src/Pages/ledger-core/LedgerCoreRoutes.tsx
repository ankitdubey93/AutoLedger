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
 */

function AppPages() {
  const base = useAppBasePath();
  return (
    <div className="flex flex-col md:flex-row md:gap-6 px-4 md:px-6">
      <LedgerCoreSidebar />
      <div className="min-w-0 flex-1 py-6 max-w-[76rem]">
        <Routes>
          <Route index element={<DashboardPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="journals" element={<JournalEntryPage />} />
          <Route path="trial-balance" element={<TrialBalancePage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="settings" element={<SettingsPage />} />
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
        element={onboarded ? <Navigate to={base} replace /> : <OnboardingPage />}
      />
      <Route
        path="*"
        element={onboarded ? <AppPages /> : <Navigate to={`${base}/onboarding`} replace />}
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
