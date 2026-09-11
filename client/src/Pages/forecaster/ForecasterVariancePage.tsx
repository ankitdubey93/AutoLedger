import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApiRequestError,
  getForecasterVariance,
  type ForecasterVarianceResponse,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';

/**
 * Budget-vs-actual variance for a plan's approved budget version.
 *
 * A plan with no approved version answers `422` — rendered as a clear empty
 * state below, never a raw error dump, since it is an expected state, not a
 * failure.
 */
export default function ForecasterVariancePage() {
  const { planId } = useParams<{ planId: string }>();
  const base = useAppBasePath();
  const [data, setData] = useState<ForecasterVarianceResponse | null>(null);
  const [noApprovedVersion, setNoApprovedVersion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (planId === undefined) return;
    let ignore = false;
    getForecasterVariance(planId)
      .then((res) => {
        if (!ignore) setData(res.variance);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 422) {
          setNoApprovedVersion(true);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load variance');
      });
    return () => {
      ignore = true;
    };
  }, [planId]);

  if (planId === undefined) return null;

  if (noApprovedVersion) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={`${base}/${planId}`} label="Back to plan" />
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <p className="text-sm text-[var(--muted)] m-0">
            This plan has no approved budget version yet. Compile and approve one from the Budget page to see
            variance.
          </p>
        </div>
      </section>
    );
  }

  if (data === null) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={`${base}/${planId}`} label="Back to plan" />
        {error !== null ? <p className="status status--bad">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`${base}/${planId}`} label="Back to plan" />

      <header>
        <h2 className="text-lg font-semibold m-0">{data.planName} — budget vs. actual</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Version {data.versionLabel} · {data.from.slice(0, 7)} – {data.to.slice(0, 7)} · base currency{' '}
          {data.baseCurrency}
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {data.rows.length === 0 && <p className="text-sm text-[var(--muted)]">No budget or actual activity in this window.</p>}

      {data.rows.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Month</th>
                <th className="p-3 font-medium">Account</th>
                <th className="p-3 font-medium text-right">Budget</th>
                <th className="p-3 font-medium text-right">Actual</th>
                <th className="p-3 font-medium text-right">Variance</th>
                <th className="p-3 font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={`${row.accountId}-${row.month}`} className="border-t border-[var(--border)]">
                  <td className="p-3">{row.month.slice(0, 7)}</td>
                  <td className="p-3">
                    {row.accountCode} {row.accountName}
                  </td>
                  <td className="p-3 text-right font-mono">{formatCents(row.budgetCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.actualCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.varianceCents)}</td>
                  <td className="p-3">
                    <span
                      className={[
                        'px-2 py-0.5 rounded text-xs font-medium',
                        row.favourable ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400',
                      ].join(' ')}
                    >
                      {row.favourable ? 'Favourable' : 'Unfavourable'}
                    </span>
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
