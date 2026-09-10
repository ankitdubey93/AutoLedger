import { Link, Outlet } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { useOrg } from '../../context/OrgContext';
import OrgSwitcher from './OrgSwitcher';

/**
 * Suite-level chrome: shown only on the app chooser ("/") and the account
 * page ("/account"). An app under /app/:appSlug is a sibling route, not a
 * child of this layout — it does not render inside this header at all.
 * Per-app chrome — a small AutoLedger mark, the app's own name, and the org/
 * user controls — is AppFrame + AppTopBar, mounted separately.
 */
export default function PlatformLayout() {
  const auth = useAuth();
  const { logout } = useAuthActions();
  const { organization, orgVersion } = useOrg();

  const email = auth.status === 'authenticated' ? auth.user.email : '';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__brand">
          <Link to="/" className="app-header__brand-link">
            <strong>AutoLedger</strong>
          </Link>
          {organization !== null && <span className="chip">{organization.name}</span>}
        </div>

        <div className="app-header__actions">
          <OrgSwitcher />
          <Link to="/documents" className="muted">
            Documents
          </Link>
          <Link to="/account" className="muted">
            {email}
          </Link>
          <button type="button" className="btn btn--ghost" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      {/*
        Keyed on the active organization. Switching tenants remounts the whole
        subtree, so every page refetches from scratch instead of briefly
        showing the previous organization's data — cache invalidation by
        identity rather than by hand.
      */}
      <main key={`${organization?.id ?? 'none'}-${orgVersion}`} className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
