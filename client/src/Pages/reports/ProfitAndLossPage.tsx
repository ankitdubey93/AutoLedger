import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getProfitAndLoss,
  getProfitAndLossComparison,
  type ComparisonMode,
  type ComparisonSection,
  type ProfitAndLoss,
  type ProfitAndLossComparison,
  type StatementRow,
  type Variance,
} from '../../services/fetchServices';
import { useLedgerSettings } from '../../context/LedgerSettingsContext';
import { fiscalYearBounds } from '../accounting/fiscalYear';
import { formatCents } from '../../utils/money';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import ExportMenu from '../../components/ui/ExportMenu';

/**
 * Profit & Loss — Revenue minus Expenses, with the 5xxx range split out as
 * cost of sales. Aggregated from raw ledger lines on every request, exactly
 * like the trial balance — there is no summary table behind this.
 *
 * Every row is a postable account (reportService.profitAndLoss's INNER JOIN
 * only returns accounts with activity), so the account name is always
 * safely linkable into that account's ledger, mirroring TrialBalancePage.
 */

function SectionRows({ rows }: { rows: StatementRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <tr key={row.accountId} className="border-t border-[var(--border)]">
          <td className="p-3 font-mono text-xs text-[var(--muted)]">{row.code}</td>
          <td className="p-3">
            <Link
              to={`/accounts/${row.accountId}`}
              className="text-[var(--text)] no-underline hover:underline"
            >
              {row.name}
            </Link>
          </td>
          <td className="p-3 text-right tabular-nums">{formatCents(row.amountCents)}</td>
        </tr>
      ))}
    </>
  );
}

function SubtotalRow({ label, amountCents }: { label: string; amountCents: number }) {
  return (
    <tr className="border-t border-[var(--border)] bg-[var(--bg)] font-medium">
      <td className="p-3" colSpan={2}>
        {label}
      </td>
      <td className="p-3 text-right tabular-nums">{formatCents(amountCents)}</td>
    </tr>
  );
}

/** '—' when the prior period was zero; display only, never fed back into money. */
function changePercent(variance: Variance): string {
  return variance.bp === null ? '—' : `${(variance.bp / 100).toFixed(1)}%`;
}

function ChangeCells({ variance }: { variance: Variance }) {
  return (
    <>
      <td className="p-3 text-right tabular-nums">{formatCents(variance.cents)}</td>
      <td className="p-3 text-right tabular-nums">{changePercent(variance)}</td>
    </>
  );
}

function ComparisonSectionRows({ section }: { section: ComparisonSection }) {
  return (
    <>
      {section.rows.map((row) => (
        <tr key={row.accountId} className="border-t border-[var(--border)]">
          <td className="p-3 font-mono text-xs text-[var(--muted)]">{row.code}</td>
          <td className="p-3">
            <Link to={`/accounts/${row.accountId}`} className="text-[var(--text)] no-underline hover:underline">
              {row.name}
            </Link>
          </td>
          {row.amountsCents.map((cents, i) => (
            <td key={i} className="p-3 text-right tabular-nums">
              {formatCents(cents)}
            </td>
          ))}
          <ChangeCells variance={row.variance} />
        </tr>
      ))}
    </>
  );
}

function ComparisonSubtotalRow({
  label,
  amountsCents,
  variance,
  strong = false,
}: {
  label: string;
  amountsCents: number[];
  variance: Variance;
  strong?: boolean;
}) {
  return (
    <tr
      className={
        strong
          ? 'border-t-2 border-[var(--border)] font-semibold'
          : 'border-t border-[var(--border)] bg-[var(--bg)] font-medium'
      }
    >
      <td className="p-3" colSpan={2}>
        {label}
      </td>
      {amountsCents.map((cents, i) => (
        <td key={i} className="p-3 text-right tabular-nums">
          {formatCents(cents)}
        </td>
      ))}
      <ChangeCells variance={variance} />
    </tr>
  );
}

function ComparisonTable({ report }: { report: ProfitAndLossComparison }) {
  const span = report.periods.length + 4;
  const heading = (label: string) => (
    <tr className="border-t border-[var(--border)]">
      <td className="p-3 font-semibold text-[var(--muted)]" colSpan={span}>
        {label}
      </td>
    </tr>
  );
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
      <table className="w-full border-collapse text-sm min-w-[40rem]">
        <thead>
          <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
            <th className="p-3 font-medium">Code</th>
            <th className="p-3 font-medium">Account</th>
            {report.periods.map((period) => (
              <th key={`${period.from}:${period.to}`} className="p-3 font-medium text-right">
                {period.label}
              </th>
            ))}
            <th className="p-3 font-medium text-right">Change</th>
            <th className="p-3 font-medium text-right">Change %</th>
          </tr>
        </thead>
        <tbody>
          {heading('Revenue')}
          <ComparisonSectionRows section={report.revenue} />
          <ComparisonSubtotalRow
            label="Total revenue"
            amountsCents={report.revenue.totalsCents}
            variance={report.revenue.variance}
          />
          {heading('Cost of sales')}
          <ComparisonSectionRows section={report.costOfSales} />
          <ComparisonSubtotalRow
            label="Total cost of sales"
            amountsCents={report.costOfSales.totalsCents}
            variance={report.costOfSales.variance}
          />
          <ComparisonSubtotalRow
            label="Gross profit"
            amountsCents={report.grossProfitCents}
            variance={report.grossProfitVariance}
          />
          {heading('Operating expenses')}
          <ComparisonSectionRows section={report.operatingExpenses} />
          <ComparisonSubtotalRow
            label="Total operating expenses"
            amountsCents={report.operatingExpenses.totalsCents}
            variance={report.operatingExpenses.variance}
          />
        </tbody>
        <tfoot>
          <ComparisonSubtotalRow
            label="Net income"
            amountsCents={report.netIncomeCents}
            variance={report.netIncomeVariance}
            strong
          />
        </tfoot>
      </table>
    </div>
  );
}

export default function ProfitAndLossPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [compare, setCompare] = useState<'none' | ComparisonMode>('none');
  const [periods, setPeriods] = useState(1);
  const [report, setReport] = useState<ProfitAndLoss | null>(null);
  const [comparison, setComparison] = useState<ProfitAndLossComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ledgerSettings = useLedgerSettings();

  useEffect(() => {
    let ignore = false;
    setError(null);
    const fromParam = from === '' ? null : from;
    const toParam = to === '' ? null : to;
    const failed = (err: unknown) => {
      if (!ignore) setError(err instanceof Error ? err.message : 'Could not load profit & loss');
    };

    if (compare === 'none') {
      getProfitAndLoss(fromParam, toParam)
        .then((res) => {
          if (!ignore) setReport(res);
        })
        .catch(failed);
    } else {
      setComparison(null);
      getProfitAndLossComparison(fromParam, toParam, compare, periods)
        .then((res) => {
          if (!ignore) setComparison(res);
        })
        .catch(failed);
    }

    return () => {
      ignore = true;
    };
  }, [from, to, compare, periods]);

  function applyShortcut(kind: 'MoM' | 'QoQ' | 'YoY') {
    const today = new Date();
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (kind === 'MoM') {
      setFrom(iso(new Date(Date.UTC(year, month, 1))));
      setTo(iso(new Date(Date.UTC(year, month + 1, 0))));
      setCompare('previousPeriod');
    } else if (kind === 'QoQ') {
      const quarterStart = Math.floor(month / 3) * 3;
      setFrom(iso(new Date(Date.UTC(year, quarterStart, 1))));
      setTo(iso(new Date(Date.UTC(year, quarterStart + 3, 0))));
      setCompare('previousPeriod');
    } else {
      const settings = ledgerSettings.status === 'ready' ? ledgerSettings.settings : null;
      const bounds = fiscalYearBounds(
        settings?.fiscalYearStartMonth ?? 1,
        settings?.fiscalYearStartDay ?? 1,
        iso(today),
      );
      setFrom(bounds.startDate);
      setTo(bounds.endDate);
      setCompare('samePeriodLastYear');
    }
    setPeriods(1);
  }

  const selectClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/reports" label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Profit &amp; loss</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Computed from raw ledger lines on every request — no stored balances.
          </p>
        </div>

        <div className="flex items-end gap-4">
          {compare === 'none' ? (
            <ExportMenu path="/reports/profit-and-loss" params={{ from: from || null, to: to || null }} />
          ) : (
            <ExportMenu
              path="/reports/profit-and-loss/comparison"
              params={{ from: from || null, to: to || null, compare, periods: String(periods) }}
            />
          )}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
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
              <option value="previousPeriod">Previous periods</option>
              <option value="samePeriodLastYear">Same period last year</option>
            </select>
          </label>
          {compare !== 'none' && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Periods</span>
              <select value={periods} onChange={(e) => setPeriods(Number(e.target.value))} className={selectClass}>
                {Array.from({ length: 11 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex gap-2">
            {(['MoM', 'QoQ', 'YoY'] as const).map((kind) => (
              <button key={kind} type="button" className="btn btn--ghost" onClick={() => applyShortcut(kind)}>
                {kind}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {compare === 'none' && report === null && error === null && <LoadingState />}
      {compare !== 'none' && comparison === null && error === null && <LoadingState />}

      {compare !== 'none' && comparison !== null && <ComparisonTable report={comparison} />}

      {compare === 'none' && report !== null && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[30rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 font-medium">Code</th>
                <th className="p-3 font-medium">Account</th>
                <th className="p-3 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-[var(--border)]">
                <td className="p-3 font-semibold text-[var(--muted)]" colSpan={3}>
                  Revenue
                </td>
              </tr>
              <SectionRows rows={report.revenue.rows} />
              <SubtotalRow label="Total revenue" amountCents={report.revenue.totalCents} />

              <tr className="border-t border-[var(--border)]">
                <td className="p-3 font-semibold text-[var(--muted)]" colSpan={3}>
                  Cost of sales
                </td>
              </tr>
              <SectionRows rows={report.costOfSales.rows} />
              <SubtotalRow label="Total cost of sales" amountCents={report.costOfSales.totalCents} />

              <SubtotalRow label="Gross profit" amountCents={report.grossProfitCents} />

              <tr className="border-t border-[var(--border)]">
                <td className="p-3 font-semibold text-[var(--muted)]" colSpan={3}>
                  Operating expenses
                </td>
              </tr>
              <SectionRows rows={report.operatingExpenses.rows} />
              <SubtotalRow
                label="Total operating expenses"
                amountCents={report.operatingExpenses.totalCents}
              />
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[var(--border)] font-semibold">
                <td className="p-3" colSpan={2}>
                  Net income
                </td>
                <td className="p-3 text-right tabular-nums">{formatCents(report.netIncomeCents)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
