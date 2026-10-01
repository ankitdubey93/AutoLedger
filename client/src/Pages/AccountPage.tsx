import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { getHealth, type HealthResponse } from '../services/fetchServices';
import { useAuth } from '../context/AuthContext';
import AccountTabs, { ACCOUNT_TABS, type AccountTab } from './AccountTabs';
import ProfilePanel from './account/ProfilePanel';
import ChangePasswordPanel from './account/ChangePasswordPanel';
import SessionsPanel from './account/SessionsPanel';
import OrganizationsPage from './organizations/OrganizationsPage';
import { initials } from '../utils/initials';

/**
 * Account settings — everything that belongs to **you**, whichever
 * organization is active: your profile, password, signed-in sessions and
 * the organizations you belong to (Phase 38a).
 *
 * Organization-level settings (the company's profile, members, accounting
 * configuration) live under /settings. Before Phase 38a this page mixed the
 * two; its old Organisation and Members tabs redirect there.
 *
 * The tab lives in `?tab=` so a link (the org menu's "Manage organizations",
 * a redirect) can open the right one.
 */

/** Pre-38a tabs that moved to Organization settings. */
const MOVED_TABS: Record<string, string> = {
  organization: '/settings/profile',
  members: '/settings/members',
};

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const parts = [days > 0 ? `${String(days)}d` : '', hours > 0 ? `${String(hours)}h` : '', minutes > 0 ? `${String(minutes)}m` : ''].filter(Boolean);
  return parts.length === 0 ? 'just started' : parts.join(' ');
}

function HealthPanel() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    getHealth()
      .then((res) => {
        if (!ignore) setHealth(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Unknown error');
      });

    return () => {
      ignore = true;
    };
  }, []);

  return (
    <section className="card">
      <h2>Service status</h2>

      {error !== null && <p className="status status--bad">Could not reach the service: {error}</p>}
      {health === null && error === null && <p className="muted">Checking…</p>}

      {health !== null && (
        <dl>
          <dt>Status</dt>
          <dd>
            <span className={`status ${health.status === 'ok' ? 'status--good' : 'status--bad'}`}>
              {health.status === 'ok' ? 'All systems operational' : 'Degraded'}
            </span>
          </dd>
          <dt>Database</dt>
          <dd>{health.db.connected ? `Connected (${String(health.db.latencyMs)} ms)` : 'Unavailable'}</dd>
          <dt>Up for</dt>
          <dd>{formatUptime(health.uptimeSeconds)}</dd>
          <dt>Version</dt>
          <dd>API {health.apiVersion}</dd>
        </dl>
      )}
    </section>
  );
}

export default function AccountPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab') ?? 'profile';

  const moved = MOVED_TABS[requested];
  if (moved !== undefined) return <Navigate to={moved} replace />;

  // AppShell renders behind ProtectedRoute, so this is defensive only.
  if (auth.status !== 'authenticated') return null;

  const tab: AccountTab = (ACCOUNT_TABS as readonly string[]).includes(requested) ? (requested as AccountTab) : 'profile';

  return (
    <div className="dashboard">
      <header className="flex items-center gap-3.5">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)] text-sm font-semibold">
          {initials(auth.user.name, auth.user.email)}
        </span>
        <div>
          <h1>Account settings</h1>
          <p className="subtitle m-0 mt-0.5">
            {auth.user.name !== null && `${auth.user.name} · `}
            {auth.user.email}
          </p>
        </div>
      </header>

      <AccountTabs active={tab} onChange={(next) => setSearchParams({ tab: next }, { replace: true })} />

      <div className="grid">
        {tab === 'profile' && <ProfilePanel />}
        {tab === 'password' && <ChangePasswordPanel />}
        {tab === 'sessions' && <SessionsPanel />}
        {tab === 'system' && <HealthPanel />}
      </div>
      {tab === 'organizations' && <OrganizationsPage />}
    </div>
  );
}
