import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { getForecasterForecast, type ForecasterForecastResponse } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from '../../components/BackLink';

/**
 * A plan's driver-and-headcount build-up, month by month, per account.
 *
 * `hasMissingDriverValues` is rendered as a visible warning banner naming
 * the affected lines, never hidden — the honest counterpart of FP&A's
 * `balances` badge: a missing driver value silently produces zero, and the
 * user must be told exactly where that happened.
 */
export default function ForecasterForecastPage() {
  const { planId } = useParams<{ planId: string }>();
  const base = useAppBasePath();
  const [data, setData] = useState<ForecasterForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (planId === undefined) return;
    let ignore = false;
    getForecasterForecast(planId)
      .then((res) => {
        if (!ignore) setData(res.forecast);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the forecast');
      });
    return () => {
      ignore = true;
    };
  }, [planId]);

  if (planId === undefined) return null;

  if (data === null) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink to={`${base}/${planId}`} label="Back to plan" />
        {error !== null ? <p className="status status--bad">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const missingLabels = new Set<string>();
  for (const month of data.build.months) {
    for (const line of month.lines) {
      if (line.missingDriverValue) missingLabels.add(line.label);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <BackLink to={`${base}/${planId}`} label="Back to plan" />

      <header>
        <h2 className="text-lg font-semibold m-0">{data.planName} — forecast</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          {data.startsOn} · {data.horizonMonths} month horizon · base currency {data.baseCurrency}
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {data.build.hasMissingDriverValues && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-sm">
            <p className="m-0 font-medium text-amber-200">Some months are missing a driver value.</p>
            <p className="m-0 mt-1 text-[var(--muted)]">
              These lines cost zero in the months affected, rather than an invented figure:{' '}
              {[...missingLabels].join(', ')}.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium sticky left-0 bg-[var(--panel)]">Account</th>
              {data.build.months.map((m) => (
                <th key={m.month} className="p-3 font-medium text-right whitespace-nowrap">
                  {m.month.slice(0, 7)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((account) => (
              <tr key={account.accountId} className="border-t border-[var(--border)]">
                <td className="p-3 sticky left-0 bg-inherit whitespace-nowrap">
                  {account.code} {account.name}
                </td>
                {data.build.months.map((m) => {
                  const total = m.accountTotals.find((t) => t.accountId === account.accountId);
                  return (
                    <td key={m.month} className="p-3 text-right tabular-nums whitespace-nowrap">
                      {formatCents(total?.amountCents ?? 0)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-[var(--border)] font-medium bg-[var(--bg)]">
              <td className="p-3 sticky left-0 bg-inherit">Total</td>
              {data.build.months.map((m) => (
                <td key={m.month} className="p-3 text-right tabular-nums whitespace-nowrap">
                  {formatCents(m.totalCents)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold m-0">Build-up by line and role</h3>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium sticky left-0 bg-[var(--panel)]">Line / role</th>
                {data.build.months.map((m) => (
                  <th key={m.month} className="p-3 font-medium text-right whitespace-nowrap">
                    {m.month.slice(0, 7)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data.build.months[0]?.lines ?? []).map((firstLine) => (
                <tr key={`line-${firstLine.lineId}`} className="border-t border-[var(--border)]">
                  <td className="p-3 sticky left-0 bg-inherit whitespace-nowrap">{firstLine.label}</td>
                  {data.build.months.map((m) => {
                    const line = m.lines.find((l) => l.lineId === firstLine.lineId);
                    return (
                      <td key={m.month} className="p-3 text-right tabular-nums whitespace-nowrap">
                        {line?.missingDriverValue === true ? (
                          <span className="text-amber-400">missing</span>
                        ) : (
                          formatCents(line?.amountCents ?? 0)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {(() => {
                const roleIds = new Set<string>();
                for (const m of data.build.months) {
                  for (const r of m.roles) roleIds.add(r.roleId);
                }
                return [...roleIds].map((roleId) => {
                  const label = data.build.months.flatMap((m) => m.roles).find((r) => r.roleId === roleId)?.title ?? '';
                  return (
                    <tr key={`role-${roleId}`} className="border-t border-[var(--border)]">
                      <td className="p-3 sticky left-0 bg-inherit whitespace-nowrap">{label}</td>
                      {data.build.months.map((m) => {
                        const role = m.roles.find((r) => r.roleId === roleId);
                        return (
                          <td key={m.month} className="p-3 text-right tabular-nums whitespace-nowrap">
                            {role === undefined ? '—' : formatCents(role.amountCents)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
