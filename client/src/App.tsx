import { useEffect, useState } from 'react';
import { getHealth, type HealthResponse } from './services/fetchServices';

/**
 * Phase 0 landing page. Its only job is to prove the three tiers are connected:
 * browser → Express → PostgreSQL. Routing, AuthProvider and OrgProvider arrive
 * in Phase 1 with the pages that need them (docs/architecture.md).
 */

type Probe =
  | { state: 'loading' }
  | { state: 'ok'; health: HealthResponse }
  | { state: 'error'; message: string };

export default function App() {
  const [probe, setProbe] = useState<Probe>({ state: 'loading' });

  useEffect(() => {
    // StrictMode runs effects twice in development. Aborting on cleanup means
    // the discarded first request cannot resolve after unmount and overwrite
    // state set by the second — the standard fetch-in-effect race.
    const controller = new AbortController();

    getHealth(controller.signal)
      .then((health) => setProbe({ state: 'ok', health }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setProbe({
          state: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <header>
        <h1>AutoLedger</h1>
        <p className="subtitle">Multi-tenant ERP · double-entry general ledger</p>
      </header>

      <section className="card">
        <h2>API connection</h2>

        {probe.state === 'loading' && <p className="muted">Checking…</p>}

        {probe.state === 'error' && (
          <>
            <p className="status status--bad">Unreachable</p>
            <p className="muted">{probe.message}</p>
            <p className="muted">
              Is the server running on <code>:5000</code>, and Postgres up via{' '}
              <code>docker compose up -d</code>?
            </p>
          </>
        )}

        {probe.state === 'ok' && (
          <>
            <p className="status status--good">Connected</p>
            <dl>
              <dt>Service</dt>
              <dd>{probe.health.service}</dd>
              <dt>API version</dt>
              <dd>{probe.health.apiVersion}</dd>
              <dt>Environment</dt>
              <dd>{probe.health.environment}</dd>
              <dt>Uptime</dt>
              <dd>{probe.health.uptimeSeconds}s</dd>
              <dt>PostgreSQL</dt>
              <dd>
                {probe.health.db.connected
                  ? `reachable (${probe.health.db.latencyMs}ms)`
                  : 'unreachable'}
              </dd>
            </dl>
          </>
        )}
      </section>

      <footer className="muted">
        Phase 0 — scaffold. Nothing else is built yet; see <code>docs/roadmap.md</code>.
      </footer>
    </main>
  );
}
