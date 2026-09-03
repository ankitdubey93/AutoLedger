import { Navigate, Outlet } from 'react-router-dom';
import { useActiveApp } from '../../apps/useActiveApp';
import { useOrg } from '../../context/OrgContext';
import AppTopBar from './AppTopBar';

/**
 * Per-app shell, mounted at /app/:appSlug as a sibling of PlatformLayout
 * rather than a child of it — inside an app, the app owns the chrome and the
 * suite header does not render at all. Resolves :appSlug itself rather than
 * trusting the URL — an unknown or not-yet-built slug redirects home instead
 * of rendering a frame for an app that does not exist.
 */
export default function AppFrame() {
  const active = useActiveApp();
  const { organization, orgVersion } = useOrg();

  if (active.status === 'loading') {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading app…</span>
      </div>
    );
  }

  if (active.status === 'not-found' || active.app.status === 'planned') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)]">
      <AppTopBar app={active.app} />
      {/*
        Keyed on the active organization, exactly like PlatformLayout's own
        <main> was — switching tenants remounts the whole subtree, which is
        what makes switching into a not-yet-onboarded organization correctly
        show LedgerCore's onboarding wizard again. Do not "optimise" it away.
      */}
      <main key={`${organization?.id ?? 'none'}-${orgVersion}`} className="flex-1 min-h-0">
        <Outlet />
      </main>
    </div>
  );
}
