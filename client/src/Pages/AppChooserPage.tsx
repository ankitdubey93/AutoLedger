import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listApps, type AppSummary } from '../services/fetchServices';

/**
 * The post-login landing page: one card per app in the suite. This replaced
 * the single-app dashboard when AutoLedger became a suite — the dashboard's
 * identity/organization/session content moved to Pages/AccountPage.tsx.
 *
 * A `building` app is a real link. A `planned` app renders as a disabled
 * card — visibly part of the portfolio, but not clickable, the same
 * "disabled rather than a lie" rule AccountPage's module list already uses.
 */
export default function AppChooserPage() {
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    listApps()
      .then((res) => {
        if (!ignore) setApps(res.apps);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load apps');
      });

    return () => {
      ignore = true;
    };
  }, []);

  return (
    <div className="dashboard">
      <header>
        <h1>Choose an app</h1>
        <p className="subtitle">Seven apps, one organization, one ledger underneath.</p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {apps === null && error === null && <p className="muted">Loading…</p>}

      {apps !== null && (
        <div className="app-grid">
          {apps.map((app) => (
            <AppCard key={app.slug} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}

function AppCard({ app }: { app: AppSummary }) {
  const body = (
    <>
      <div className="app-card__head">
        <h2 className="app-card__name">{app.name}</h2>
        {app.status === 'planned' && <span className="chip chip--muted">Coming soon</span>}
      </div>
      <p className="app-card__domain">{app.domain}</p>
      <p className="muted">{app.tagline}</p>
      <ul className="app-card__skills">
        {app.skills.map((skill) => (
          <li key={skill}>{skill}</li>
        ))}
      </ul>
    </>
  );

  if (app.status === 'planned') {
    return (
      <div className="card app-card app-card--disabled" aria-disabled="true">
        {body}
      </div>
    );
  }

  return (
    <Link to={`/app/${app.slug}`} className="card app-card">
      {body}
    </Link>
  );
}
