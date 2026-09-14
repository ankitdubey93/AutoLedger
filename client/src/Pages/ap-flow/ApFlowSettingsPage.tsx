import { useEffect, useState } from 'react';
import { getApFlowSettings, updateApFlowSettings } from '../../services/fetchServices';
import { formatCents, parseCentsInput } from '../../utils/money';
import BackLink from '../../components/BackLink';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * AP-Flow's settings page (Phase 19) — the auto-post gate a reviewer or
 * owner tunes. Google Drive intake is a separate, larger surface and is not
 * part of this page yet.
 */
export default function ApFlowSettingsPage() {
  const base = useAppBasePath();

  const [loaded, setLoaded] = useState(false);
  const [autoPostEnabled, setAutoPostEnabled] = useState(false);
  const [minConfidence, setMinConfidence] = useState('0.90');
  const [maxTotal, setMaxTotal] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let ignore = false;
    getApFlowSettings()
      .then((res) => {
        if (ignore) return;
        setAutoPostEnabled(res.settings.autoPostEnabled);
        setMinConfidence(res.settings.autoPostMinConfidence.toFixed(2));
        setMaxTotal(res.settings.autoPostMaxTotalCents === null ? '' : formatCents(res.settings.autoPostMaxTotalCents));
        setUpdatedAt(res.settings.updatedAt);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load settings');
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSave() {
    setError(null);
    setSaved(false);

    const confidence = Number(minConfidence);
    if (!Number.isFinite(confidence) || confidence < 0.5 || confidence > 1) {
      setError('Minimum confidence must be between 0.5 and 1');
      return;
    }

    let maxTotalCents: number | null = null;
    if (maxTotal.trim() !== '') {
      const parsed = parseCentsInput(maxTotal);
      if (parsed === null || parsed <= 0) {
        setError('Enter an amount like 1500.00, or leave it blank for no limit');
        return;
      }
      maxTotalCents = parsed;
    }

    setSaving(true);
    try {
      const res = await updateApFlowSettings({
        autoPostEnabled,
        autoPostMinConfidence: confidence,
        autoPostMaxTotalCents: maxTotalCents,
      });
      setUpdatedAt(res.settings.updatedAt);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 max-w-xl">
      <BackLink to={base} label="AP-Flow" />
      <header>
        <h2 className="text-lg font-semibold m-0">AP-Flow settings</h2>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {!loaded && error === null && <p className="muted">Loading…</p>}

      {loaded && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3">
          <h3 className="text-sm font-semibold m-0">Auto-posting</h3>
          <p className="text-sm text-[var(--muted)] m-0">
            Documents that fail any check stay in the review queue with the reason shown.
          </p>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoPostEnabled}
              onChange={(e) => setAutoPostEnabled(e.target.checked)}
            />
            Post automatically when every check passes
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Minimum confidence</span>
            <input
              type="number"
              min={0.5}
              max={1}
              step={0.01}
              value={minConfidence}
              onChange={(e) => setMinConfidence(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] max-w-[10rem]"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Auto-post limit (base currency, blank for none)</span>
            <input
              type="text"
              placeholder="e.g. 1500.00"
              value={maxTotal}
              onChange={(e) => setMaxTotal(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] max-w-[12rem]"
            />
          </label>

          <div className="flex items-center gap-3">
            <button type="button" disabled={saving} onClick={() => void handleSave()} className="btn">
              Save
            </button>
            {saved && <span className="text-emerald-400 text-sm">Saved</span>}
            {updatedAt !== null && (
              <span className="text-[var(--muted)] text-sm">Last saved {new Date(updatedAt).toLocaleString()}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
