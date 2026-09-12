import { useEffect, useState } from 'react';
import {
  getSandboxStatus,
  loadSandbox,
  unloadSandbox,
  type SandboxCounts,
  type SandboxStatus,
} from '../services/fetchServices';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from '../components/ConfirmDialog';

/**
 * The sandbox dataset card — Phase 18. Rendered on the app chooser beside
 * SetupChecklist, because "this organization has nothing in it yet" and
 * "here is one click that fills it" belong in the same place.
 *
 * Status is readable by every member (knowing whether sample data is loaded
 * is harmless and useful context), but Load and Remove are OWNER-only and
 * **hidden** rather than disabled for anyone else — the same posture
 * BoardDeckDecksPage and UniteconSettingsPage each take for their own
 * role-gated destructive actions.
 *
 * A load genuinely takes tens of seconds: it replays 24 months of history
 * through the real services rather than bulk-inserting rows. The button
 * therefore reports progress rather than appearing frozen, and the
 * ConfirmDialog body says so before the user commits to waiting.
 */

/** Display order and labels for the counts, so the grid reads app by app. */
const COUNT_LABELS: readonly (readonly [keyof SandboxCounts, string])[] = [
  ['customers', 'Customers'],
  ['invoices', 'Invoices'],
  ['vendors', 'Vendors'],
  ['bills', 'Bills'],
  ['payments', 'Payments'],
  ['bankLines', 'Bank lines'],
  ['apFlowDocuments', 'AP-Flow docs'],
  ['forecastPlans', 'Forecast plans'],
  ['fpaModels', 'FP&A models'],
  ['productLines', 'Product lines'],
  ['closeRuns', 'Close runs'],
  ['corpusDocuments', 'Tax acts'],
];

export default function SandboxCard() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canManage = role === 'OWNER';

  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'load' | 'unload' | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let ignore = false;

    getSandboxStatus()
      .then((res) => {
        // Defensive, the same call SetupChecklist makes: an unexpected
        // response shape (a test harness that mocks every fetch identically,
        // say) must leave the chooser working rather than crash it.
        if (!ignore && res.sandbox !== undefined && typeof res.sandbox.loaded === 'boolean') {
          setStatus(res.sandbox);
        }
      })
      .catch(() => {
        // The chooser still works without this card — it simply does not render.
      });

    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  async function handleLoad() {
    setBusy(true);
    setError(null);
    try {
      await loadSandbox();
      setConfirming(null);
      setReloadToken((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sample data');
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleUnload() {
    setBusy(true);
    setError(null);
    try {
      await unloadSandbox();
      setConfirming(null);
      setReloadToken((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove sample data');
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  if (status === null) return null;

  const dataset = status.dataset;

  return (
    <section className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold m-0">Sample data</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            {status.loaded
              ? 'A 24-month demo dataset is loaded across all seven apps.'
              : 'Fill this organization with 24 months of realistic activity — customers, invoices, bills, payments, a bank statement to reconcile, forecasts, and a tax act — so every app has something real to show.'}
          </p>
        </div>
        {canManage && !status.loaded && (
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirming('load')}>
            {busy ? 'Loading…' : 'Load sample data'}
          </button>
        )}
        {canManage && status.loaded && (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => setConfirming('unload')}
          >
            Remove
          </button>
        )}
      </div>

      {error !== null && <p className="status status--bad m-0">{error}</p>}

      {busy && confirming === null && !status.loaded && (
        <p className="text-sm text-[var(--muted)] m-0" role="status">
          Seeding 24 months through the real services — this takes a little while.
        </p>
      )}

      {dataset !== null && (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 m-0">
            {COUNT_LABELS.map(([key, label]) => (
              <div key={key} className="flex items-baseline justify-between gap-2">
                <dt className="text-xs text-[var(--muted)]">{label}</dt>
                <dd className="text-sm m-0 tabular-nums">{dataset.counts[key]}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-[var(--muted)] m-0">
            Dataset {dataset.datasetVersion}, anchored at {dataset.anchorMonth}.
          </p>
        </>
      )}

      {confirming === 'load' && (
        <ConfirmDialog
          title="Load sample data?"
          body={
            <>
              This writes about two years of invoices, bills, payments and bank lines into{' '}
              <strong>this organization&apos;s own books</strong>, through the same services a real user
              would. It takes tens of seconds, and it cannot be undone by removing the marker afterwards.
            </>
          }
          confirmLabel="Load sample data"
          busy={busy}
          onConfirm={handleLoad}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming === 'unload' && (
        <ConfirmDialog
          title="Remove sample data?"
          body={
            <>
              This clears the <strong>marker only</strong>. The seeded invoices, bills, payments and journal
              entries stay — posted financial documents are immutable by design, so they cannot be deleted
              from here. To remove them, delete the organization.
            </>
          }
          confirmLabel="Remove marker"
          tone="danger"
          busy={busy}
          onConfirm={handleUnload}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}
