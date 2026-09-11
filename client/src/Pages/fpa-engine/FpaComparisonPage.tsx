import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Star, XCircle } from 'lucide-react';
import { getFpaComparison, type FpaComparisonResponse } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';

export default function FpaComparisonPage() {
  const { modelId } = useParams<{ modelId: string }>();
  const base = useAppBasePath();
  const [data, setData] = useState<FpaComparisonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (modelId === undefined) return;
    let ignore = false;
    getFpaComparison(modelId)
      .then((res) => {
        if (!ignore) setData(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the comparison');
      });
    return () => {
      ignore = true;
    };
  }, [modelId]);

  if (modelId === undefined) return null;

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/${modelId}`} label="Back to model" />

      <header>
        <h2 className="text-lg font-semibold m-0">{data?.modelName ?? 'Scenario comparison'}</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">Every scenario in this model, side by side.</p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {data === null && error === null && <p className="muted">Loading…</p>}

      {data !== null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[52rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Scenario</th>
                <th className="p-3 font-medium">Kind</th>
                <th className="p-3 font-medium">Runway</th>
                <th className="p-3 font-medium">Cash-out</th>
                <th className="p-3 font-medium text-right">Closing cash</th>
                <th className="p-3 font-medium text-right">Total revenue</th>
                <th className="p-3 font-medium text-right">Total net income</th>
                <th className="p-3 font-medium text-center">Balances</th>
              </tr>
            </thead>
            <tbody>
              {data.scenarios.map((s) => (
                <tr key={s.scenarioId} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <Link
                      to={`${base}/scenarios/${s.scenarioId}`}
                      className="text-[var(--text)] no-underline hover:underline flex items-center gap-1.5"
                    >
                      {s.isDefault && <Star size={13} aria-hidden="true" className="text-amber-400" />}
                      {s.scenarioName}
                    </Link>
                  </td>
                  <td className="p-3 text-[var(--muted)]">{s.kind}</td>
                  <td className="p-3">{s.runwayMonths === null ? '—' : `${String(s.runwayMonths)} mo`}</td>
                  <td className="p-3">{s.cashOutMonth === null ? '—' : s.cashOutMonth.slice(0, 7)}</td>
                  <td className="p-3 text-right tabular-nums">{formatCents(s.closingCashCents)}</td>
                  <td className="p-3 text-right tabular-nums">{formatCents(s.totalRevenueCents)}</td>
                  <td className="p-3 text-right tabular-nums">{formatCents(s.totalNetIncomeCents)}</td>
                  <td className="p-3 text-center">
                    {s.balances ? (
                      <CheckCircle2 size={16} aria-hidden="true" className="inline text-emerald-400" />
                    ) : (
                      <XCircle size={16} aria-hidden="true" className="inline text-rose-400" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
