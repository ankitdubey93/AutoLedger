import { useEffect, useState } from 'react';
import { getAiUsage, type AiUsageSummary } from '../../services/fetchServices';
import { formatMicroUsd } from '../../utils/money';
import BackLink from '../../components/BackLink';

/**
 * Capture's AI usage report (Phase 19.1) — every metered token/cost call
 * this app has made, org-scoped. A model with no verified price in
 * config/aiPricing.ts records its tokens but no cost; that gap is shown
 * explicitly rather than silently rolled into a total that would then
 * understate real spend.
 */
export default function AiUsagePage() {

  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();

    getAiUsage(
      {
        module: 'ap-flow',
        ...(from !== '' && { from }),
        ...(to !== '' && { to }),
      },
      controller.signal,
    )
      .then((res) => {
        if (!ignore) {
          setUsage(res.usage);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load AI usage');
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [from, to]);

  return (
    <section className="flex flex-col gap-5">
      <BackLink to="/settings" label="Back to settings" />

      <header>
        <h2 className="text-lg font-semibold m-0">AI usage</h2>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-sm text-[var(--text)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2 py-1 text-sm text-[var(--text)]"
          />
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}

      {usage === null && error === null && <p className="muted">Loading…</p>}

      {usage !== null && usage.totals.callCount === 0 && (
        <p className="muted">No model calls recorded yet.</p>
      )}

      {usage !== null && usage.totals.callCount > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
              <p className="text-xs text-[var(--muted)] m-0">Calls</p>
              <p className="text-lg font-semibold m-0 mt-1">{usage.totals.callCount}</p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
              <p className="text-xs text-[var(--muted)] m-0">Input tokens</p>
              <p className="text-lg font-semibold m-0 mt-1">{usage.totals.inputTokens.toLocaleString()}</p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
              <p className="text-xs text-[var(--muted)] m-0">Output tokens</p>
              <p className="text-lg font-semibold m-0 mt-1">{usage.totals.outputTokens.toLocaleString()}</p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
              <p className="text-xs text-[var(--muted)] m-0">Total tokens</p>
              <p className="text-lg font-semibold m-0 mt-1">{usage.totals.totalTokens.toLocaleString()}</p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
              <p className="text-xs text-[var(--muted)] m-0">Cost</p>
              <p className="text-lg font-semibold m-0 mt-1">${formatMicroUsd(usage.totals.costMicroUsd)}</p>
            </div>
          </div>

          {usage.totals.unpricedCallCount > 0 && (
            <p className="text-sm text-[var(--muted)] m-0">
              {usage.totals.unpricedCallCount} call(s) from a model with no published price in this build
              are not included in the cost.
            </p>
          )}

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium m-0">By model</p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1.5 border-b border-[var(--border)]">Provider</th>
                  <th className="text-left px-2 py-1.5 border-b border-[var(--border)]">Model</th>
                  <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Calls</th>
                  <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Input</th>
                  <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Output</th>
                  <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.byModel.map((row) => (
                  <tr key={row.key}>
                    <td className="px-2 py-1.5 border-b border-[var(--border)]">{row.provider}</td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)]">{row.key}</td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">{row.callCount}</td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">
                      {row.inputTokens.toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">
                      {row.outputTokens.toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">
                      ${formatMicroUsd(row.costMicroUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium m-0">By purpose</p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1.5 border-b border-[var(--border)]">Purpose</th>
                  <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Calls</th>
                  <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.byPurpose.map((row) => (
                  <tr key={row.key}>
                    <td className="px-2 py-1.5 border-b border-[var(--border)]">{row.key}</td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">{row.callCount}</td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">
                      ${formatMicroUsd(row.costMicroUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium m-0">By day</p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1.5 border-b border-[var(--border)]">Date</th>
                  <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Calls</th>
                  <th className="text-right px-2 py-1.5 border-b border-[var(--border)]">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.byDay.map((row) => (
                  <tr key={row.date}>
                    <td className="px-2 py-1.5 border-b border-[var(--border)]">{row.date}</td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">{row.callCount}</td>
                    <td className="px-2 py-1.5 border-b border-[var(--border)] text-right">
                      ${formatMicroUsd(row.costMicroUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-[var(--muted)] m-0">Prices as of {usage.pricingVersion}.</p>
        </>
      )}
    </section>
  );
}
