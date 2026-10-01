import { useCallback, useEffect, useState } from 'react';
import { listSessions, revokeOtherSessions, revokeSession, type ActiveSession } from '../../services/fetchServices';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import LoadingState from '../../components/ui/LoadingState';
import { secondaryButtonClass } from '../../components/ui/formClasses';
import { describeUserAgent } from '../../utils/describeUserAgent';

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Formats the remaining access-token lifetime as m:ss, or "expired". */
function useCountdown(isoTarget: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Date.parse(isoTarget) - now;
  if (Number.isNaN(remaining)) return 'unknown';
  if (remaining <= 0) return 'expired — will refresh on next request';
  const totalSeconds = Math.floor(remaining / 1000);
  return `${String(Math.floor(totalSeconds / 60))}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/**
 * Account settings → Sessions (Phase 38a): every browser signed in to this
 * account, with sign-out for one or for all the others. A signed-out browser
 * keeps working until its access token expires (up to 15 minutes), then
 * finds its session gone at the next refresh.
 */
export default function SessionsPanel() {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSessions((await listSessions()).sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your sessions');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <>
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0">Where you're signed in</h2>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={busy || others === 0}
            onClick={() => void run(revokeOtherSessions)}
          >
            Sign out of all other sessions
          </button>
        </div>

        {error !== null && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}
        {sessions === null && error === null && <LoadingState />}

        {sessions !== null && (
          <ul className="mt-3 flex flex-col divide-y divide-[var(--border)] p-0 m-0 list-none">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <div className="font-medium">
                    {describeUserAgent(s.userAgent)}
                    {s.current && <span className="chip ml-2">This device</span>}
                  </div>
                  <div className="muted text-sm">
                    {s.ip ?? 'Unknown IP'} · signed in {formatWhen(s.startedAt)} · last active {formatWhen(s.lastActiveAt)}
                    {s.organizationName !== null && ` · ${s.organizationName}`}
                  </div>
                </div>
                {!s.current && (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={busy}
                    onClick={() => void run(() => revokeSession(s.id))}
                  >
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <TokenDetails />
    </>
  );
}

/**
 * The access-token countdown and manual refresh (the old Session tab), kept
 * behind a disclosure: it makes token rotation observable, which matters to
 * a developer and to nobody else.
 */
function TokenDetails() {
  const auth = useAuth();
  const { refreshNow } = useAuthActions();
  const countdown = useCountdown(auth.status === 'authenticated' ? auth.accessTokenExpiresAt : '');
  const [busy, setBusy] = useState(false);

  return (
    <section className="card">
      <details>
        <summary className="cursor-pointer text-sm font-medium">Token details (developer)</summary>
        <dl className="mt-3">
          <dt>Access token expires in</dt>
          <dd>{countdown}</dd>
        </dl>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void refreshNow().finally(() => setBusy(false));
          }}
        >
          {busy ? 'Refreshing…' : 'Refresh now'}
        </button>
        <p className="muted">Tokens live in httpOnly cookies, so this page cannot read them — the server reports the expiry.</p>
      </details>
    </section>
  );
}
