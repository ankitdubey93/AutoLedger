import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useEnabledApps, resolveActiveApp } from '../../apps/useEnabledApps';
import { useOrg } from '../../context/OrgContext';
import AppTopBar from './AppTopBar';
import AppFooter from './AppFooter';
import CommandPalette from './CommandPalette';
import { ShellProvider } from './ShellContext';

/**
 * Per-app shell, mounted at /app/:appSlug as a sibling of PlatformLayout
 * rather than a child of it — inside an app, the app owns the chrome and the
 * suite header does not render at all. Resolves :appSlug itself rather than
 * trusting the URL — an unknown or not-yet-built slug redirects home instead
 * of rendering a frame for an app that does not exist.
 *
 * `useEnabledApps` fetches once per organization (not per `:appSlug`, unlike
 * the `useActiveApp` this replaced in Phase 31), so switching from one app to
 * another via the app-switcher menu re-renders with data already in hand —
 * no skeleton flash. See study/react/routing-nested-and-dynamic-segments.md.
 */
export default function AppFrame() {
  const enabled = useEnabledApps();
  const { appSlug } = useParams<{ appSlug: string }>();
  const active = resolveActiveApp(enabled, appSlug);
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
    <ShellProvider>
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
        <AppFooter app={active.app} />
        <CommandPalette />
      </div>
    </ShellProvider>
  );
}
