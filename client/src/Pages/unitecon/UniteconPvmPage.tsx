import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { ApiRequestError, fetchUniteconPvm, type PvmResponse } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

function toMonthValue(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function defaultPeriods(): { baseFrom: string; baseTo: string; compareFrom: string; compareTo: string } {
  const now = new Date();
  const compareMonth = toMonthValue(now);
  const baseDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const baseMonth = toMonthValue(baseDate);
  return {
    baseFrom: `${baseMonth}-01`,
    baseTo: `${baseMonth}-01`,
    compareFrom: `${compareMonth}-01`,
    compareTo: `${compareMonth}-01`,
  };
}

/**
 * Price-Volume-Mix variance between two periods, at product-line (revenue
 * account) grain.
 *
 * `excludedForeignCurrencyInvoices` is rendered as a visible banner, never
 * hidden — invoice_lines carries no base-currency column, so a
 * foreign-currency invoice cannot be converted at line grain and is
 * excluded rather than silently misreported.
 */
export default function UniteconPvmPage() {
  const base = useAppBasePath();
  const initial = defaultPeriods();
  const [baseFromMonth, setBaseFromMonth] = useState(initial.baseFrom.slice(0, 7));
  const [baseToMonth, setBaseToMonth] = useState(initial.baseTo.slice(0, 7));
  const [compareFromMonth, setCompareFromMonth] = useState(initial.compareFrom.slice(0, 7));
  const [compareToMonth, setCompareToMonth] = useState(initial.compareTo.slice(0, 7));
  const [data, setData] = useState<PvmResponse | null>(null);
  const [needsProductLine, setNeedsProductLine] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseFrom = `${baseFromMonth}-01`;
  const baseTo = `${baseToMonth}-01`;
  const compareFrom = `${compareFromMonth}-01`;
  const compareTo = `${compareToMonth}-01`;

  useEffect(() => {
    let ignore = false;
    setError(null);
    setNeedsProductLine(false);
    fetchUniteconPvm(baseFrom, baseTo, compareFrom, compareTo)
      .then((res) => {
        if (!ignore) setData(res.pvm);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 422 && err.message.includes('product line')) {
          setNeedsProductLine(true);
          setData(null);
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load the PVM report');
      });
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFrom, baseTo, compareFrom, compareTo]);

  if (needsProductLine) {
    return (
      <section className="flex flex-col gap-4">
        <header>
          <h2 className="text-lg font-semibold m-0">Price-Volume-Mix</h2>
        </header>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <p className="text-sm text-[var(--muted)] m-0">
            Configure at least one product line before running a PVM report.{' '}
            <Link to={`${base}/settings`} className="text-[var(--text)] underline">
              Go to Settings
            </Link>
            .
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Price-Volume-Mix</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          The change in sales between two periods, decomposed by price, volume and mix.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <fieldset className="flex items-center gap-2 border border-[var(--border)] rounded-md p-2">
          <legend className="text-xs text-[var(--muted)] px-1">Base period</legend>
          <input type="month" value={baseFromMonth} onChange={(e) => setBaseFromMonth(e.target.value)} className={inputClass} />
          <span className="text-[var(--muted)]">–</span>
          <input type="month" value={baseToMonth} onChange={(e) => setBaseToMonth(e.target.value)} className={inputClass} />
        </fieldset>
        <fieldset className="flex items-center gap-2 border border-[var(--border)] rounded-md p-2">
          <legend className="text-xs text-[var(--muted)] px-1">Comparison period</legend>
          <input type="month" value={compareFromMonth} onChange={(e) => setCompareFromMonth(e.target.value)} className={inputClass} />
          <span className="text-[var(--muted)]">–</span>
          <input type="month" value={compareToMonth} onChange={(e) => setCompareToMonth(e.target.value)} className={inputClass} />
        </fieldset>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}

      {data === null && error === null && <p className="muted">Loading…</p>}

      {data !== null && data.excludedForeignCurrencyInvoices > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="m-0 text-sm text-amber-200">
            {data.excludedForeignCurrencyInvoices} invoice{data.excludedForeignCurrencyInvoices === 1 ? '' : 's'}{' '}
            in a currency other than your base currency {data.excludedForeignCurrencyInvoices === 1 ? 'is' : 'are'}{' '}
            excluded from this report.
          </p>
        </div>
      )}

      {data !== null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Product line</th>
                <th className="p-3 font-medium text-right">Base qty</th>
                <th className="p-3 font-medium text-right">Compare qty</th>
                <th className="p-3 font-medium text-right">Base net</th>
                <th className="p-3 font-medium text-right">Compare net</th>
                <th className="p-3 font-medium text-right">Price</th>
                <th className="p-3 font-medium text-right">Volume</th>
                <th className="p-3 font-medium text-right">Mix</th>
                <th className="p-3 font-medium text-right">Total variance</th>
              </tr>
            </thead>
            <tbody>
              {data.report.rows.map((row) => (
                <tr key={row.productLineId} className="border-t border-[var(--border)]">
                  <td className="p-3">{row.productLineName}</td>
                  <td className="p-3 text-right font-mono">{(row.baseQuantityMilli / 1000).toFixed(1)}</td>
                  <td className="p-3 text-right font-mono">{(row.compareQuantityMilli / 1000).toFixed(1)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.baseNetCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.compareNetCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.priceVarianceCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.volumeVarianceCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.mixVarianceCents)}</td>
                  <td className="p-3 text-right font-mono">{formatCents(row.totalVarianceCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--border)] font-medium">
                <td className="p-3">Total</td>
                <td className="p-3" colSpan={2} />
                <td className="p-3 text-right font-mono">{formatCents(data.report.totals.baseNetCents)}</td>
                <td className="p-3 text-right font-mono">{formatCents(data.report.totals.compareNetCents)}</td>
                <td className="p-3 text-right font-mono">{formatCents(data.report.totals.priceVarianceCents)}</td>
                <td className="p-3 text-right font-mono">{formatCents(data.report.totals.volumeVarianceCents)}</td>
                <td className="p-3 text-right font-mono">{formatCents(data.report.totals.mixVarianceCents)}</td>
                <td className="p-3 text-right font-mono">{formatCents(data.report.totals.totalVarianceCents)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
