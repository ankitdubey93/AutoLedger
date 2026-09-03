import { Layers } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { useOrg } from '../../context/OrgContext';
import type { AppSummary } from '../../services/fetchServices';
import OrgSwitcher from './OrgSwitcher';

/**
 * The top bar rendered inside an app (mounted by AppFrame), replacing the
 * suite-level PlatformLayout header while inside /app/:appSlug. AutoLedger
 * shrinks to a small mark-and-link on the left rather than owning the page —
 * the app is the main part now, not the suite.
 */
export default function AppTopBar({ app }: { app: AppSummary }) {
  const auth = useAuth();
  const { logout } = useAuthActions();
  const { organization } = useOrg();

  const email = auth.status === 'authenticated' ? auth.user.email : '';

  return (
    <header className="app-topbar sticky top-0 z-30 h-14 flex items-center gap-3 px-4 border-b border-[var(--border)] bg-[var(--panel)]">
      <Link
        to="/"
        title="All AutoLedger apps"
        className="flex items-center gap-1.5 shrink-0 no-underline text-[var(--muted)] hover:text-[var(--text)] transition-colors"
      >
        <Layers size={15} aria-hidden="true" />
        <span className="text-xs tracking-wide">AutoLedger</span>
      </Link>
      <span aria-hidden="true" className="text-[var(--border)]">
        /
      </span>
      <span className="font-semibold text-[15px] truncate">{app.name}</span>
      <div className="ml-auto flex items-center gap-3">
        <OrgSwitcher />
        {organization !== null && <span className="chip">{organization.name}</span>}
        <Link to="/account" className="muted">
          {email}
        </Link>
        <button type="button" className="btn btn--ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </header>
  );
}
