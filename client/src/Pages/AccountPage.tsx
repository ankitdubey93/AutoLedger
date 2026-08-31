import { useEffect, useState } from 'react';
import {
  getHealth,
  listMembers,
  ApiRequestError,
  type HealthResponse,
  type OrganizationMember,
} from '../services/fetchServices';
import { useAuth, useAuthActions } from '../context/AuthContext';
import { useOrg } from '../context/OrgContext';

/**
 * The account page: identity, organization, membership, and session details
 * that apply across the whole suite rather than to any one app. This used to
 * be the post-login landing page; the app chooser (Pages/AppChooserPage.tsx)
 * took that role when AutoLedger became a suite of apps — see /account's
 * link from PlatformLayout's header.
 *
 * Every value below comes from a real Phase 1 endpoint. There is no
 * placeholder data and no link to a screen that does not exist — the modules
 * that are not built yet are shown as visibly disabled rather than as
 * something that looks clickable and leads to an empty table.
 */

/** Formats the remaining access-token lifetime as m:ss, or "expired". */
function useCountdown(isoTarget: string): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // One second is the coarsest tick that still looks live.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = Date.parse(isoTarget) - now;
  if (Number.isNaN(remaining)) return 'unknown';
  if (remaining <= 0) return 'expired — will refresh on next request';

  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

function MembersPanel() {
  const { role } = useOrg();
  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `ignore` rather than AbortController — see the note in AuthContext.tsx:
  // aborting a StrictMode-discarded request mid-CORS-preflight made the
  // surviving request fail with "Failed to fetch".
  useEffect(() => {
    let ignore = false;

    listMembers()
      .then((res) => {
        if (!ignore) setMembers(res.members);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        // A 403 is not a failure — it is RBAC working, and worth showing as
        // such rather than as an error.
        if (err instanceof ApiRequestError && err.status === 403) {
          setDenied(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load members');
      });

    return () => {
      ignore = true;
    };
  }, []);

  return (
    <section className="card">
      <h2>Members</h2>

      {denied && (
        <p className="muted">
          Visible to <code>OWNER</code> and <code>ADMIN</code> only. Your role is{' '}
          <code>{role ?? 'unknown'}</code>.
        </p>
      )}

      {error !== null && <p className="status status--bad">{error}</p>}

      {!denied && error === null && members === null && <p className="muted">Loading…</p>}

      {members !== null && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td>{m.name ?? '—'}</td>
                  <td>{m.email}</td>
                  <td>
                    <span className="chip">{m.role}</span>
                  </td>
                  <td>{new Date(m.joinedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SessionPanel({ expiresAt }: { expiresAt: string }) {
  const { refreshNow } = useAuthActions();
  const countdown = useCountdown(expiresAt);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onRefresh() {
    setBusy(true);
    try {
      await refreshNow();
      setLastRefresh(new Date().toLocaleTimeString());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Session</h2>
      <dl>
        <dt>Access token expires in</dt>
        <dd>{countdown}</dd>
        <dt>Last manual refresh</dt>
        <dd>{lastRefresh ?? 'none this visit'}</dd>
      </dl>
      {/*
        Normally invisible — the fetch wrapper refreshes on a 401 without
        anyone asking. Exposing it makes the rotation observable.
      */}
      <button type="button" className="btn btn--ghost" onClick={() => void onRefresh()} disabled={busy}>
        {busy ? 'Refreshing…' : 'Refresh now'}
      </button>
      <p className="muted">
        Tokens live in httpOnly cookies, so this page cannot read them — the server reports the
        expiry.
      </p>
    </section>
  );
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
      <h2>System</h2>

      {error !== null && <p className="status status--bad">{error}</p>}
      {health === null && error === null && <p className="muted">Checking…</p>}

      {health !== null && (
        <dl>
          <dt>API</dt>
          <dd>
            {health.service} · {health.apiVersion} · {health.environment}
          </dd>
          <dt>PostgreSQL</dt>
          <dd>
            {health.db.connected
              ? `reachable (${String(health.db.latencyMs)}ms)`
              : 'unreachable'}
          </dd>
          <dt>Uptime</dt>
          <dd>{health.uptimeSeconds}s</dd>
        </dl>
      )}

      <h3 className="panel-subhead">Platform</h3>
      <ul className="module-list">
        <li>
          <span className="status--good">✓</span> Identity &amp; tenancy
        </li>
        <li>
          <span className="status--good">✓</span> App registry
        </li>
        {/* Disabled, not linked. A link to an empty table would be a lie. */}
        <li className="module-list__pending">
          LedgerCore — chart of accounts <span className="chip chip--muted">Phase 3</span>
        </li>
        <li className="module-list__pending">
          LedgerCore — journal entries <span className="chip chip--muted">Phase 3</span>
        </li>
        <li className="module-list__pending">
          LedgerCore — trial balance <span className="chip chip--muted">Phase 3</span>
        </li>
      </ul>
    </section>
  );
}

export default function AccountPage() {
  const auth = useAuth();
  const { organization, role } = useOrg();

  // PlatformLayout renders behind ProtectedRoute, so this is defensive only.
  if (auth.status !== 'authenticated') return null;

  return (
    <div className="dashboard">
      <header>
        <h1>Account</h1>
        <p className="subtitle">Your identity, organization, and session — across every app in the suite.</p>
      </header>

      <div className="grid">
        <section className="card">
          <h2>You</h2>
          <dl>
            <dt>Name</dt>
            <dd>{auth.user.name ?? '—'}</dd>
            <dt>Email</dt>
            <dd>{auth.user.email}</dd>
            <dt>Email verified</dt>
            <dd>
              {auth.user.emailVerified ? (
                'yes'
              ) : (
                // Honest about scope rather than showing a button that does nothing.
                <span className="muted">not verified — verification arrives in a later phase</span>
              )}
            </dd>
            <dt>Member since</dt>
            <dd>{new Date(auth.user.createdAt).toLocaleDateString()}</dd>
          </dl>
        </section>

        <section className="card">
          <h2>Organization</h2>
          {organization === null ? (
            <p className="muted">No active organization.</p>
          ) : (
            <dl>
              <dt>Name</dt>
              <dd>{organization.name}</dd>
              <dt>Slug</dt>
              <dd>
                <code>{organization.slug}</code>
              </dd>
              <dt>Base currency</dt>
              <dd>{organization.baseCurrency}</dd>
              <dt>Your role</dt>
              <dd>
                <span className="chip">{role ?? '—'}</span>
              </dd>
              <dt>Organizations</dt>
              <dd>{auth.memberships.length}</dd>
            </dl>
          )}
        </section>

        <MembersPanel />
        <SessionPanel expiresAt={auth.accessTokenExpiresAt} />
        <HealthPanel />
      </div>
    </div>
  );
}
