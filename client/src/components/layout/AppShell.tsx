import { Link, Navigate, Outlet } from 'react-router-dom';
import { useActiveApp } from '../../apps/useActiveApp';

/**
 * Per-app chrome, one layer inside PlatformLayout: which app you are in, and
 * a way back to the chooser. Resolves `:appSlug` itself rather than trusting
 * the URL — an unknown or not-yet-built slug redirects home instead of
 * rendering a header for an app that does not exist.
 */
export default function AppShell() {
  const active = useActiveApp();

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
    <div className="app-shell">
      <header className="app-shell__header">
        <Link to="/" className="muted">
          ← All apps
        </Link>
        <h1 className="app-shell__title">{active.app.name}</h1>
      </header>
      <Outlet />
    </div>
  );
}
