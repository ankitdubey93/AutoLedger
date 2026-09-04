import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getProfitAndLoss, type ProfitAndLoss, type StatementRow } from '../../services/fetchServices';
import { formatCents } from './money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from './BackLink';

/**
 * Profit & Loss — Revenue minus Expenses, with the 5xxx range split out as
 * cost of sales. Aggregated from raw ledger lines on every request, exactly
 * like the trial balance — there is no summary table behind this.
 *
 * Every row is a postable account (reportService.profitAndLoss's INNER JOIN
 * only returns accounts with activity), so the account name is always
 * safely linkable into that account's ledger, mirroring TrialBalancePage.
 */

function SectionRows({ rows, base }: { rows: StatementRow[]; base: string }) {
  return (
    <>
      {rows.map((row) => (
        <tr key={row.accountId} className="border-t border-[var(--border)]">
          <td className="p-3 font-mono text-xs text-[var(--muted)]">{row.code}</td>
          <td className="p-3">
            <Link
              to={`${base}/accounts/${row.accountId}`}
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

export default function ProfitAndLossPage() {
  const base = useAppBasePath();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<ProfitAndLoss | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    setError(null);

    getProfitAndLoss(from === '' ? null : from, to === '' ? null : to)
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : 'Could not load profit & loss');
        }
      });

    return () => {
      ignore = true;
    };
  }, [from, to]);

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/reports`} label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Profit &amp; loss</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Computed from raw ledger lines on every request — no stored balances.
          </p>
        </div>

        <div className="flex items-end gap-4">
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
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <p className="muted">Loading…</p>}

      {report !== null && (
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
              <SectionRows rows={report.revenue.rows} base={base} />
              <SubtotalRow label="Total revenue" amountCents={report.revenue.totalCents} />

              <tr className="border-t border-[var(--border)]">
                <td className="p-3 font-semibold text-[var(--muted)]" colSpan={3}>
                  Cost of sales
                </td>
              </tr>
              <SectionRows rows={report.costOfSales.rows} base={base} />
              <SubtotalRow label="Total cost of sales" amountCents={report.costOfSales.totalCents} />

              <SubtotalRow label="Gross profit" amountCents={report.grossProfitCents} />

              <tr className="border-t border-[var(--border)]">
                <td className="p-3 font-semibold text-[var(--muted)]" colSpan={3}>
                  Operating expenses
                </td>
              </tr>
              <SectionRows rows={report.operatingExpenses.rows} base={base} />
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
