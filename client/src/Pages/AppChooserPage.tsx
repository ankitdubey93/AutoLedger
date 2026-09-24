import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowRight, Grid2x2 } from 'lucide-react';
import { getOrganizationApps, type AppSummary, type OrganizationAppsResponse } from '../services/fetchServices';
import { useOrg } from '../context/OrgContext';
import { APP_BRAND } from '../apps/registry';
import SetupChecklist from './SetupChecklist';

/**
 * The post-login landing page: one card per app in the suite. This replaced
 * the single-app dashboard when AutoLedger became a suite — the dashboard's
 * identity/organization/session content moved to Pages/AccountPage.tsx.
 *
 * A `building` app is a real link. A `planned` app renders as a disabled
 * card — visibly part of the portfolio, but not clickable, the same
 * "disabled rather than a lie" rule AccountPage uses.
 *
 * Phase 27: only the apps this organization has enabled are shown. An
 * organization that has never chosen (`selectionCompletedAt === null`) is
 * sent to the picker at /welcome first. OWNER/ADMIN get a link to Account's
 * Apps panel to change the set.
 */
export default function AppChooserPage() {
  const { role } = useOrg();
  const [data, setData] = useState<OrganizationAppsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    getOrganizationApps()
      .then((res) => {
        if (!ignore) setData(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load apps');
      });

    return () => {
      ignore = true;
    };
  }, []);

  if (data !== null && data.selectionCompletedAt === null) return <Navigate to="/welcome" replace />;

  const apps = data === null ? null : data.apps.filter((a) => a.enabled);
  const count = apps?.length ?? 0;

  return (
    <div className="dashboard">
      <header>
        <h1>Choose an app</h1>
        <p className="subtitle">
          {count} {count === 1 ? 'app' : 'apps'}, one organization, one ledger underneath.
        </p>
        {(role === 'OWNER' || role === 'ADMIN') && <Link to="/account#apps">Add or remove apps</Link>}
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {data === null && error === null && <p className="muted">Loading…</p>}

      {apps !== null && (
        <div className="app-grid">
          {apps.map((app) => (
            <AppCard key={app.slug} app={app} />
          ))}
        </div>
      )}

      <SetupChecklist enabledSlugs={new Set((apps ?? []).map((a) => a.slug))} />
    </div>
  );
}

function AppCard({ app }: { app: AppSummary }) {
  const brand = APP_BRAND[app.slug];
  const Icon = brand?.icon ?? Grid2x2;
  const color = brand?.color ?? 'var(--accent)';

  const body = (
    <>
      <div className="app-card__head">
        <span
          aria-hidden="true"
          className="flex size-9 items-center justify-center rounded-lg text-white shrink-0"
          style={{ background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 70%, black))` }}
        >
          <Icon size={18} />
        </span>
        {app.status === 'planned' && <span className="chip chip--muted">Coming soon</span>}
      </div>
      <h2 className="app-card__name">{app.name}</h2>
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
    <Link to={`/app/${app.slug}`} className="card card--interactive app-card group">
      {body}
      <span className="mt-auto flex items-center gap-1 text-xs font-medium text-[var(--accent)]">
        Open
        <ArrowRight size={13} aria-hidden="true" className="transition-transform group-hover:translate-x-1" />
      </span>
    </Link>
  );
}
