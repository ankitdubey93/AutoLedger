import { Outlet } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { useOrg } from '../../context/OrgContext';
import OrgSwitcher from './OrgSwitcher';

/**
 * Chrome for every authenticated page: identity, the organization switcher,
 * logout, and the outlet the routed page renders into.
 */
export default function AppLayout() {
  const auth = useAuth();
  const { logout } = useAuthActions();
  const { organization, orgVersion } = useOrg();

  const email = auth.status === 'authenticated' ? auth.user.email : '';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__brand">
          <strong>AutoLedger</strong>
          {organization !== null && <span className="chip">{organization.name}</span>}
        </div>

        <div className="app-header__actions">
          <OrgSwitcher />
          <span className="muted">{email}</span>
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
