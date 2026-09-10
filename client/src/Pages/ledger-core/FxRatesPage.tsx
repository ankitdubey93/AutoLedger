import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { deleteFxRate, listFxRates, upsertFxRate, type FxRate } from '../../services/fetchServices';
import { useLedgerSettings } from './LedgerSettingsContext';
import ConfirmDialog from './ConfirmDialog';

/**
 * Exchange rates — Phase 8. A rate is always recorded foreign -> base: `toCode`
 * is fixed to the organization's own base currency and shown read-only, never
 * chosen, so every rate this page creates is the one every document/payment
 * service actually looks up.
 */

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'SGD', 'AED', 'CHF', 'NZD', 'ZAR'] as const;

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

function RateForm({
  baseCurrency,
  onCreated,
  onCancel,
}: {
  baseCurrency: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const fromOptions = CURRENCIES.filter((c) => c !== baseCurrency);
  const [fromCode, setFromCode] = useState(fromOptions[0] ?? '');
  const [rateDate, setRateDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // `rate` is sent as the raw string the user typed — never routed
      // through a number, which would risk float drift on 8 decimal places.
      await upsertFxRate({ fromCode, toCode: baseCurrency, rateDate, rate: rate.trim() });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not record the rate');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <h3 className="text-sm font-semibold m-0">New rate</h3>
      <p className="text-xs text-[var(--muted)] m-0">
        Rates are always recorded foreign → base — every rate here converts into{' '}
        <strong>{baseCurrency}</strong>, the organization&rsquo;s base currency.
      </p>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-32">
          <span className="text-[var(--muted)]">From currency</span>
          <select value={fromCode} onChange={(e) => setFromCode(e.target.value)} className={inputClass}>
            {fromOptions.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-32">
          <span className="text-[var(--muted)]">To currency</span>
          <input type="text" value={baseCurrency} disabled className={inputClass} />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-32">
          <span className="text-[var(--muted)]">Rate date</span>
          <input
            type="date"
            required
            value={rateDate}
            onChange={(e) => setRateDate(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-32">
          <span className="text-[var(--muted)]">Rate</span>
          <input
            type="text"
            required
            inputMode="decimal"
            placeholder="83.50000000"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || rate.trim() === '' || fromCode === ''}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Saving…' : 'Save rate'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn--ghost">
          Cancel
        </button>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
    </form>
  );
}

export default function FxRatesPage() {
  const settings = useLedgerSettings();
  const [rates, setRates] = useState<FxRate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<FxRate | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let ignore = false;
    listFxRates({ limit: 100 })
      .then((res) => {
        if (!ignore) setRates(res.rates);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load exchange rates');
      });
    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  if (settings.status !== 'ready') {
    return <p className="muted">Loading…</p>;
  }
  const baseCurrency = settings.settings.baseCurrency;

  async function confirmDelete() {
    if (pendingDelete === null) return;
    setDeleting(true);
    try {
      await deleteFxRate(pendingDelete.id);
      setPendingDelete(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete the rate');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Exchange rates</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Every rate here converts a foreign currency into {baseCurrency}, this organization&rsquo;s base
            currency.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((open) => !open)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)]"
        >
          <Plus size={15} aria-hidden="true" /> New rate
        </button>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {showForm && (
        <RateForm
          baseCurrency={baseCurrency}
          onCreated={() => {
            setShowForm(false);
            setReloadToken((t) => t + 1);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {rates === null && error === null && <p className="muted">Loading…</p>}

      {rates !== null && rates.length === 0 && !showForm && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)] m-0">No exchange rates recorded yet.</p>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)]"
          >
            Record the first rate
          </button>
        </div>
      )}

      {rates !== null && rates.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[36rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">From</th>
                <th className="p-3 font-medium">To</th>
                <th className="p-3 font-medium">Date</th>
                <th className="p-3 font-medium">Rate</th>
                <th className="p-3 font-medium">Source</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((rate) => (
                <tr key={rate.id} className="border-t border-[var(--border)]">
                  <td className="p-3">{rate.fromCode}</td>
                  <td className="p-3">{rate.toCode}</td>
                  <td className="p-3">{rate.rateDate}</td>
                  <td className="p-3 font-mono">{rate.rate}</td>
                  <td className="p-3 text-[var(--muted)]">{rate.source}</td>
                  <td className="p-3 text-right">
                    <button type="button" onClick={() => setPendingDelete(rate)} className="btn btn--ghost">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete this rate?"
          body={
            <p className="m-0">
              {pendingDelete.fromCode} → {pendingDelete.toCode} on {pendingDelete.rateDate} will be removed. Any
              document or payment already posted keeps the rate it used.
            </p>
          }
          confirmLabel="Delete"
          tone="danger"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
