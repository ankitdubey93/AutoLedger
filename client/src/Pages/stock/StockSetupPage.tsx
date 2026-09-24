import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useAppBasePath } from '../../apps/useAppBasePath';
import {
  applyStockProfile,
  fetchStockProfiles,
  fetchStockSettings,
  type StockIndustryKey,
  type StockIndustryProfileSummary,
  type StockSettings,
} from '../../services/fetchServices';

/**
 * StockLedger's setup wizard: choose an industry, preview what it seeds,
 * apply it. Applying is additive (setupService.applyIndustryProfile never
 * removes or overwrites), so an already-configured org gets a secondary
 * "add another template" flow that reuses the same three steps and the
 * same endpoint rather than a different one.
 */
export default function StockSetupPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN';
  const base = useAppBasePath();
  const navigate = useNavigate();

  const [settings, setSettings] = useState<StockSettings | null>(null);
  const [profiles, setProfiles] = useState<StockIndustryProfileSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<StockIndustryKey | null>(null);
  const [addingAnother, setAddingAnother] = useState(false);
  const [applying, setApplying] = useState(false);
  const [created, setCreated] = useState<{
    uoms: number;
    categories: number;
    attributes: number;
    codeSchemes: number;
    locations: number;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetchStockSettings(controller.signal), fetchStockProfiles(controller.signal)])
      .then(([settingsRes, profilesRes]) => {
        setSettings(settingsRes.settings);
        setProfiles(profilesRes.profiles);
        setSelectedKey((current) => current ?? settingsRes.settings.suggestedProfile);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Could not load StockLedger setup');
      });
    return () => controller.abort();
  }, []);

  async function handleApply() {
    if (selectedKey === null) return;
    setApplying(true);
    setError(null);
    try {
      const res = await applyStockProfile(selectedKey);
      setSettings(res.settings);
      setCreated(res.created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the industry template');
    } finally {
      setApplying(false);
    }
  }

  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-[var(--bad)]">
        {error}
      </p>
    );
  }

  if (settings === null || profiles.length === 0) {
    return <p>Loading…</p>;
  }

  if (created !== null) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-lg font-semibold text-[var(--text)]">StockLedger is set up</h1>
        <ul className="text-sm text-[var(--muted)] space-y-1">
          <li>{created.uoms} units of measure</li>
          <li>{created.categories} categories</li>
          <li>{created.attributes} custom fields</li>
          <li>{created.codeSchemes} item-code schemes</li>
          <li>{created.locations} locations</li>
        </ul>
        <Link
          to={`${base}/dashboard`}
          className="inline-block rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-4 py-2 text-sm font-medium text-white no-underline"
          onClick={() => navigate(`${base}/dashboard`)}
        >
          Continue to dashboard
        </Link>
      </div>
    );
  }

  if (settings.configured && !addingAnother) {
    const current = profiles.find((p) => p.key === settings.industryProfile);
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-lg font-semibold text-[var(--text)]">StockLedger setup</h1>
        <p className="text-sm text-[var(--text)]">
          Currently configured for <strong>{current?.name ?? settings.industryProfile}</strong>.
        </p>
        <button
          type="button"
          onClick={() => setAddingAnother(true)}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
        >
          Add another industry's template
        </button>
      </div>
    );
  }

  const selectedProfile = profiles.find((p) => p.key === selectedKey) ?? null;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">StockLedger setup</h1>

      <section aria-label="Choose your industry">
        <h2 className="text-sm font-medium text-[var(--text)] mb-2">1. Choose your industry</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {profiles.map((profile) => {
            const isSuggested = profile.key === settings.suggestedProfile;
            const isSelected = profile.key === selectedKey;
            return (
              <button
                key={profile.key}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedKey(profile.key)}
                className={[
                  'text-left rounded-md border px-3 py-2.5',
                  isSelected ? 'border-[var(--accent)] bg-[var(--panel)]' : 'border-[var(--border)]',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text)]">{profile.name}</span>
                  {isSuggested ? (
                    <span className="text-xs rounded-full bg-[var(--good)] text-white px-2 py-0.5">Suggested</span>
                  ) : null}
                </div>
                <p className="text-xs text-[var(--muted)] mt-1">{profile.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      {selectedProfile !== null ? (
        <section aria-label="Preview">
          <h2 className="text-sm font-medium text-[var(--text)] mb-2">2. Preview</h2>
          <p className="text-xs text-[var(--muted)] mb-2">You can add, rename or deactivate any of this later.</p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="pr-3 py-1">Code</th>
                <th className="pr-3 py-1">Name</th>
                <th className="pr-3 py-1">Type</th>
                <th className="pr-3 py-1">Tracking</th>
                <th className="pr-3 py-1">Custom fields</th>
              </tr>
            </thead>
            <tbody>
              {selectedProfile.categories.map((category) => (
                <tr key={category.code} className="border-t border-[var(--border)]">
                  <td className="pr-3 py-1 text-[var(--text)]">{category.code}</td>
                  <td className="pr-3 py-1 text-[var(--text)]">{category.name}</td>
                  <td className="pr-3 py-1 text-[var(--muted)]">{category.itemType}</td>
                  <td className="pr-3 py-1 text-[var(--muted)]">{category.defaultTracking}</td>
                  <td className="pr-3 py-1 text-[var(--muted)]">
                    {category.attributes.map((a) => a.label).join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 space-y-1">
            {selectedProfile.codeSchemes.map((scheme) => (
              <div key={scheme.name} className="text-sm text-[var(--text)]">
                {scheme.name} <code className="text-[var(--muted)]">{scheme.pattern}</code>{' '}
                {scheme.isDefault ? (
                  <span className="text-xs rounded-full bg-[var(--panel)] px-2 py-0.5 text-[var(--muted)]">default</span>
                ) : null}
                <span className="text-[var(--muted)]"> — example {scheme.example}</span>
              </div>
            ))}
          </div>

          <p className="text-sm text-[var(--muted)] mt-3">Default location: {selectedProfile.locationName}</p>
        </section>
      ) : null}

      <section aria-label="Apply">
        <h2 className="text-sm font-medium text-[var(--text)] mb-2">3. Apply</h2>
        {canWrite ? (
          <button
            type="button"
            disabled={applying || selectedKey === null}
            onClick={() => void handleApply()}
            className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Set up StockLedger
          </button>
        ) : (
          <p className="text-sm text-[var(--muted)]">Ask an owner or admin to finish setup.</p>
        )}
      </section>
    </div>
  );
}
