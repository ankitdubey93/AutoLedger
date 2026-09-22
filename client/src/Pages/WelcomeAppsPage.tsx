import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import AppPicker from '../components/AppPicker';
import { getOrganizationApps, setOrganizationApps, type OrganizationAppsResponse } from '../services/fetchServices';
import { useOrg } from '../context/OrgContext';

/**
 * The suite-level onboarding step — Phase 27. A newly registered
 * organization lands here (AppChooserPage redirects while
 * `selectionCompletedAt` is null) and picks the apps it will use.
 *
 * Once a selection has been saved this page redirects home; later changes
 * happen in Account's Apps panel instead. Only OWNER/ADMIN can choose — the
 * server enforces that too — so any other role sees who to ask.
 */
export default function WelcomeAppsPage() {
  const { organization, role } = useOrg();
  const navigate = useNavigate();

  const [data, setData] = useState<OrganizationAppsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    getOrganizationApps()
      .then((res) => {
        if (!ignore) setData(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setLoadError(err instanceof Error ? err.message : 'Could not load apps');
      });

    return () => {
      ignore = true;
    };
  }, []);

  async function onContinue() {
    setSubmitting(true);
    setError(null);
    try {
      await setOrganizationApps([...selected]);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your apps');
      setSubmitting(false);
    }
  }

  if (loadError !== null) return <p className="status status--bad">{loadError}</p>;
  if (data === null) return <p className="muted">Loading…</p>;
  if (data.selectionCompletedAt !== null) return <Navigate to="/" replace />;

  if (role !== 'OWNER' && role !== 'ADMIN') {
    return (
      <div className="dashboard">
        <header>
          <h1>Choose your apps</h1>
        </header>
        <p className="muted">
          An owner or admin of {organization?.name ?? 'your organization'} needs to choose which apps your
          organization uses.
        </p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header>
        <h1>Choose your apps</h1>
        <p className="subtitle">
          Pick the apps your organization needs. You can add or remove apps later in Account settings.
        </p>
      </header>

      <AppPicker apps={data.apps} selected={selected} onChange={setSelected} disabled={submitting} />

      {error !== null && (
        <p className="status status--bad" role="alert">
          {error}
        </p>
      )}

      <div>
        <button
          type="button"
          className="btn"
          disabled={selected.size === 0 || submitting}
          onClick={() => void onContinue()}
        >
          {submitting ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
