import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchUniteconUnitEconomics, type UnitEconomicsReport } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

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

function formatCell(value: number | null): string {
  return value === null ? '—' : formatCents(value);
}

/**
 * LTV/CAC unit economics per acquisition cohort.
 *
 * LTV here is OBSERVED cumulative gross margin per acquired customer through
 * the end of the window — never a modelled lifetime, never extrapolated.
 * That is stated plainly, always visible, not tucked into a tooltip.
 */
export default function UniteconUnitEconomicsPage() {
  const base = useAppBasePath();
  const initial = defaultWindow();
  const [fromMonth, setFromMonth] = useState(initial.from.slice(0, 7));
  const [toMonth, setToMonth] = useState(initial.to.slice(0, 7));
  const [data, setData] = useState<UnitEconomicsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = `${fromMonth}-01`;
  const to = `${toMonth}-01`;

  useEffect(() => {
    let ignore = false;
    setError(null);
    fetchUniteconUnitEconomics(from, to)
      .then((res) => {
        if (!ignore) setData(res.unitEconomics);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load unit economics');
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Unit economics</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          CAC and LTV per acquisition cohort.{' '}
          {data !== null && <>Gross margin assumption: {(data.grossMarginBps / 100).toFixed(1)}%.</>}{' '}
          <Link to={`${base}/settings`} className="text-[var(--muted)] underline">
            Adjust in Settings
          </Link>
          .
        </p>
      </header>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          From
          <input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} className={inputClass} />
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          To
          <input type="month" value={toMonth} onChange={(e) => setToMonth(e.target.value)} className={inputClass} />
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}

      {data === null && error === null && <p className="muted">Loading…</p>}

      <div className="rounded-lg border border-[var(--border)] bg-amber-500/10 p-3">
        <p className="m-0 text-sm text-amber-200">
          LTV is observed cumulative gross margin per acquired customer through the end of this window. It is
          not a modelled lifetime and assumes no future revenue.
        </p>
      </div>

      {data !== null && data.rows.length === 0 && (
        <p className="text-sm text-[var(--muted)]">No cohorts acquired in this window.</p>
      )}

      {data !== null && data.rows.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Cohort</th>
                <th className="p-3 font-medium text-right">New customers</th>
                <th className="p-3 font-medium text-right">Spend</th>
                <th className="p-3 font-medium text-right">CAC</th>
                <th className="p-3 font-medium text-right">LTV</th>
                <th className="p-3 font-medium text-right">LTV:CAC</th>
                <th className="p-3 font-medium text-right">Payback</th>
                <th className="p-3 font-medium text-right">Observed</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.cohortMonth} className="border-t border-[var(--border)]">
                  <td className="p-3">{row.cohortMonth.slice(0, 7)}</td>
                  <td className="p-3 text-right font-mono">{row.newCustomers}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.acquisitionSpendCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCell(row.cacCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCell(row.ltvCents)}</td>
                  <td className="p-3 text-right font-mono">
                    {row.ltvToCacBps === null ? '—' : `${(row.ltvToCacBps / 100).toFixed(1)}%`}
                  </td>
                  <td className="p-3 text-right font-mono">
                    {row.paybackMonths === null ? '—' : `${String(row.paybackMonths)} mo`}
                  </td>
                  <td className="p-3 text-right font-mono">{row.observedMonths} mo</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--border)] font-medium">
                <td className="p-3">Total</td>
                <td className="p-3 text-right font-mono">{data.totalNewCustomers}</td>
                <td className="p-3 text-right font-mono">{formatCents(data.totalAcquisitionSpendCents)}</td>
                <td className="p-3 text-right font-mono">{formatCell(data.blendedCacCents)}</td>
                <td className="p-3" colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
