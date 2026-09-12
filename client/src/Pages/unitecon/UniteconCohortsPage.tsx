import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { fetchUniteconCohorts, type UniteconCohortResponse } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

/** 'YYYY-MM' for a Date, used only to seed the default window. */
function toMonthValue(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function defaultWindow(): { from: string; to: string } {
  const now = new Date();
  const toMonth = toMonthValue(now);
  const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const fromMonth = toMonthValue(fromDate);
  return { from: `${fromMonth}-01`, to: `${toMonth}-01` };
}

/**
 * Cohort retention matrix — one row per acquisition month, one column per
 * month observed since.
 *
 * `excludedPriorCustomers` is rendered as a visible banner, never hidden —
 * the honest counterpart of ForecasterPro's `missingDriverValue` warning: a
 * customer acquired before the window is silently absent from every row
 * unless the user is told exactly how many.
 */
export default function UniteconCohortsPage() {
  const initial = defaultWindow();
  const [fromMonth, setFromMonth] = useState(initial.from.slice(0, 7));
  const [toMonth, setToMonth] = useState(initial.to.slice(0, 7));
  const [data, setData] = useState<UniteconCohortResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = `${fromMonth}-01`;
  const to = `${toMonth}-01`;

  useEffect(() => {
    let ignore = false;
    setError(null);
    fetchUniteconCohorts(from, to)
      .then((res) => {
        if (!ignore) setData(res.cohorts);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load cohorts');
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Cohort retention</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Customers grouped by their first month of revenue, tracked forward.
        </p>
      </header>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          From
          <input
            type="month"
            value={fromMonth}
            onChange={(e) => setFromMonth(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          To
          <input
            type="month"
            value={toMonth}
            onChange={(e) => setToMonth(e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}

      {data === null && error === null && <p className="muted">Loading…</p>}

      {data !== null && data.matrix.excludedPriorCustomers > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="m-0 text-sm text-amber-200">
            {data.matrix.excludedPriorCustomers} customer{data.matrix.excludedPriorCustomers === 1 ? '' : 's'}{' '}
            acquired before this window {data.matrix.excludedPriorCustomers === 1 ? 'is' : 'are'} excluded from
            every cohort.
          </p>
        </div>
      )}

      {data !== null && data.matrix.rows.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No customers acquired in this window.</p>
      )}

      {data !== null && data.matrix.rows.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium sticky left-0 bg-[var(--panel)]">Cohort</th>
                <th className="p-3 font-medium text-right">Size</th>
                {data.matrix.months.map((m) => (
                  <th key={m} className="p-3 font-medium text-right whitespace-nowrap">
                    {m.slice(0, 7)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.matrix.rows.map((row) => (
                <tr key={row.cohortMonth} className="border-t border-[var(--border)]">
                  <td className="p-3 sticky left-0 bg-inherit whitespace-nowrap">{row.cohortMonth.slice(0, 7)}</td>
                  <td className="p-3 text-right font-mono">{row.cohortSize}</td>
                  {data.matrix.months.map((m, idx) => {
                    const cell = row.cells.find((c) => c.month === m);
                    const cohortStartIdx = data.matrix.months.indexOf(row.cohortMonth);
                    if (idx < cohortStartIdx || cell === undefined) {
                      return <td key={m} className="p-3 text-right text-[var(--muted)]">—</td>;
                    }
                    return (
                      <td key={m} className="p-3 text-right whitespace-nowrap">
                        <div className="font-mono">{(cell.retentionBps / 100).toFixed(1)}%</div>
                        <div className="text-xs text-[var(--muted)]">{formatCents(cell.netRevenueCents)}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
