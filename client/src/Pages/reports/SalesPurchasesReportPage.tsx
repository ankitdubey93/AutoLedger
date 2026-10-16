import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getSalesPurchasesReport,
  type ComparisonMode,
  type SalesPurchasesReport,
  type SalesPurchasesReportKind,
  type SalesPurchasesRow,
} from '../../services/fetchServices';
import { formatCents, formatQuantity } from '../../utils/money';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import ExportMenu from '../../components/ui/ExportMenu';

/**
 * Sales and purchases grouped by customer, vendor or item over a date range,
 * optionally compared with a prior period. Party rows link to the party's
 * account; item rows do not.
 */

const TITLES: Record<SalesPurchasesReportKind, string> = {
  'sales-by-customer': 'Sales by customer',
  'purchases-by-vendor': 'Purchases by vendor',
  'sales-by-item': 'Sales by item',
  'purchases-by-item': 'Purchases by item',
};

const ITEM_FOOTNOTE =
  'Item totals are allocated per line and can differ from the ledger by rounding cents. Credit and debit notes carry no item and appear under No item.';

const selectClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

/** The first and last day of the current month, UTC, like the P&L shortcuts. */
function currentMonthRange(): { from: string; to: string } {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: iso(new Date(Date.UTC(year, month, 1))),
    to: iso(new Date(Date.UTC(year, month + 1, 0))),
  };
}

function PartyOrItemLabel({ kind, row }: { kind: SalesPurchasesReportKind; row: SalesPurchasesRow }) {
  if (kind === 'sales-by-item' || kind === 'purchases-by-item' || row.key === 'none') {
    return <>{row.label}</>;
  }
  const prefix = kind === 'sales-by-customer' ? '/customers' : '/vendors';
  return (
    <Link to={`${prefix}/${row.key}`} className="text-[var(--text)] no-underline hover:underline">
      {row.label}
    </Link>
  );
}

function SalesPurchasesTable({ kind, report }: { kind: SalesPurchasesReportKind; report: SalesPurchasesReport }) {
  const isItem = kind === 'sales-by-item' || kind === 'purchases-by-item';
  const hasComparison = report.comparison !== null;
  const labelHeader = kind === 'sales-by-customer' ? 'Customer' : kind === 'purchases-by-vendor' ? 'Vendor' : 'Item';
  // Cells before Net: the label (and code and quantity for items).
  const leadingCount = isItem ? 3 : 1;

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[30rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              {isItem && <th className="p-3 font-medium">Code</th>}
              <th className="p-3 font-medium">{labelHeader}</th>
              {isItem && <th className="p-3 font-medium text-right">Quantity</th>}
              <th className="p-3 font-medium text-right">Net</th>
              <th className="p-3 font-medium text-right">Tax</th>
              <th className="p-3 font-medium text-right">Gross</th>
              <th className="p-3 font-medium text-right">Documents</th>
              {hasComparison && (
                <th className="p-3 font-medium text-right">{report.comparison?.label}</th>
              )}
              {hasComparison && <th className="p-3 font-medium text-right">Change</th>}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.key} className="border-t border-[var(--border)]">
                {isItem && <td className="p-3">{row.code ?? ''}</td>}
                <td className="p-3">
                  <PartyOrItemLabel kind={kind} row={row} />
                </td>
                {isItem && (
                  <td className="p-3 text-right tabular-nums">
                    {row.quantityMilli === null ? '—' : formatQuantity(row.quantityMilli)}
                  </td>
                )}
                <td className="p-3 text-right tabular-nums">{formatCents(row.netCents)}</td>
                <td className="p-3 text-right tabular-nums">{formatCents(row.taxCents)}</td>
                <td className="p-3 text-right tabular-nums">{formatCents(row.grossCents)}</td>
                <td className="p-3 text-right tabular-nums">{row.documentCount}</td>
                {hasComparison && (
                  <td className="p-3 text-right tabular-nums">
                    {row.comparisonNetCents === null ? '—' : formatCents(row.comparisonNetCents)}
                  </td>
                )}
                {hasComparison && (
                  <td className="p-3 text-right tabular-nums">
                    {row.comparisonNetCents === null ? '—' : formatCents(row.netCents - row.comparisonNetCents)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--border)] font-semibold">
              <td className="p-3" colSpan={leadingCount}>
                Total
              </td>
              <td className="p-3 text-right tabular-nums">{formatCents(report.totalNetCents)}</td>
              <td className="p-3 text-right tabular-nums">{formatCents(report.totalTaxCents)}</td>
              <td className="p-3 text-right tabular-nums">{formatCents(report.totalGrossCents)}</td>
              <td className="p-3" />
              {hasComparison && (
                <td className="p-3 text-right tabular-nums">
                  {report.totalComparisonNetCents === null ? '—' : formatCents(report.totalComparisonNetCents)}
                </td>
              )}
              {hasComparison && (
                <td className="p-3 text-right tabular-nums">
                  {report.totalComparisonNetCents === null
                    ? '—'
                    : formatCents(report.totalNetCents - report.totalComparisonNetCents)}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
      {isItem && <span className="text-xs text-[var(--muted)]">{ITEM_FOOTNOTE}</span>}
    </div>
  );
}

export default function SalesPurchasesReportPage({ kind }: { kind: SalesPurchasesReportKind }) {
  const initial = currentMonthRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [compare, setCompare] = useState<'none' | ComparisonMode>('none');
  const [report, setReport] = useState<SalesPurchasesReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    setError(null);

    if (from === '' || to === '') return;
    getSalesPurchasesReport(kind, from, to, compare === 'none' ? null : compare)
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : `Could not load ${TITLES[kind].toLowerCase()}`);
      });

    return () => {
      ignore = true;
    };
  }, [kind, from, to, compare]);

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/reports" label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{TITLES[kind]}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">Net, tax and gross for the period.</p>
        </div>

        <div className="flex items-end gap-4 flex-wrap">
          <ExportMenu
            path={`/reports/${kind}`}
            params={{ from: from || null, to: to || null, compare: compare === 'none' ? null : compare }}
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={selectClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={selectClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Compare</span>
            <select
              value={compare}
              onChange={(e) => setCompare(e.target.value as 'none' | ComparisonMode)}
              className={selectClass}
            >
              <option value="none">No comparison</option>
              <option value="previousPeriod">Previous period</option>
              <option value="samePeriodLastYear">Same period last year</option>
            </select>
          </label>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <LoadingState />}

      {report !== null && <SalesPurchasesTable kind={kind} report={report} />}
    </section>
  );
}
