import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useOrg } from '../../context/OrgContext';
import { getLedgerDashboard, type DashboardSummary } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { formatCents } from './money';
import TrendChart from './TrendChart';

/**
 * LedgerCore's home page. Every figure is aggregated from raw `ledger_lines`
 * on each request — the same "no summary table" rule `TrialBalancePage`
 * states for its own report.
 */

function entryTotalCents(lines: { debitCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.debitCents, 0);
}

export default function DashboardPage() {
  const { organization } = useOrg();
  const base = useAppBasePath();
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    getLedgerDashboard()
      .then((res) => {
        if (!ignore) setDashboard(res);
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : 'Could not load the dashboard');
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  if (error !== null) {
    return <p className="status status--bad">{error}</p>;
  }

  if (dashboard === null) {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        <div className="skeleton skeleton--title" />
        <div className="skeleton skeleton--card" />
        <span className="visually-hidden">Loading dashboard…</span>
      </div>
    );
  }

  const { position, performance, activity, integrity, trend, fiscalYear } = dashboard;

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">{organization?.name ?? 'Dashboard'}</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">{fiscalYear.label}</p>
      </header>

      {!position.equationHolds && (
        <p className="status status--bad">
          Assets do not equal Liabilities + Equity + current earnings — this should be impossible.
        </p>
      )}

      <div className="grid">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Assets</p>
          <p className="text-xl font-semibold m-0 mt-1 tabular-nums">
            {formatCents(position.assetsCents)}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Liabilities</p>
          <p className="text-xl font-semibold m-0 mt-1 tabular-nums">
            {formatCents(position.liabilitiesCents)}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Equity</p>
          <p className="text-xl font-semibold m-0 mt-1 tabular-nums">
            {formatCents(position.equityCents)}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Cash</p>
          {position.cashCents === null ? (
            <>
              <p className="text-xl font-semibold m-0 mt-1">—</p>
              <p className="text-xs text-[var(--muted)] m-0 mt-1">
                No cash account configured — set one in Settings.
              </p>
            </>
          ) : (
            <p className="text-xl font-semibold m-0 mt-1 tabular-nums">
              {formatCents(position.cashCents)}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <p className="text-sm font-medium m-0 mb-3">This fiscal year</p>
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Revenue</dt>
              <dd className="m-0 tabular-nums">{formatCents(performance.yearToDate.revenueCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Expenses</dt>
              <dd className="m-0 tabular-nums">{formatCents(performance.yearToDate.expenseCents)}</dd>
            </div>
            <div className="flex justify-between font-medium">
              <dt>Net income</dt>
              <dd
                className="m-0 tabular-nums"
                style={{ color: performance.yearToDate.netIncomeCents < 0 ? 'var(--bad)' : undefined }}
              >
                {formatCents(performance.yearToDate.netIncomeCents)}
              </dd>
            </div>
          </dl>
        </div>
        <div className="card">
          <p className="text-sm font-medium m-0 mb-3">This month</p>
          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Revenue</dt>
              <dd className="m-0 tabular-nums">{formatCents(performance.currentMonth.revenueCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Expenses</dt>
              <dd className="m-0 tabular-nums">{formatCents(performance.currentMonth.expenseCents)}</dd>
            </div>
            <div className="flex justify-between font-medium">
              <dt>Net income</dt>
              <dd
                className="m-0 tabular-nums"
                style={{ color: performance.currentMonth.netIncomeCents < 0 ? 'var(--bad)' : undefined }}
              >
                {formatCents(performance.currentMonth.netIncomeCents)}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="card">
        <p className="text-sm font-medium m-0 mb-3">Last 6 months</p>
        <TrendChart points={trend} />
      </div>

      <div className="card">
        <p className="text-sm font-medium m-0 mb-3">Recent entries</p>
        {activity.recentEntries.length === 0 ? (
          <p className="text-sm text-[var(--muted)] m-0">No activity yet.</p>
        ) : (
          <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[28rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">Description</th>
                  <th className="p-3 font-medium text-right">Lines</th>
                  <th className="p-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {activity.recentEntries.map((entry) => (
                  <tr key={entry.id} className="border-t border-[var(--border)]">
                    <td className="p-3">
                      <Link to={`${base}/journals`} className="text-[var(--text)]">
                        {entry.entryDate}
                      </Link>
                    </td>
                    <td className="p-3">{entry.description ?? '—'}</td>
                    <td className="p-3 text-right tabular-nums">{entry.lines.length}</td>
                    <td className="p-3 text-right tabular-nums">
                      {formatCents(entryTotalCents(entry.lines))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div
        className={[
          'flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm ring-1 ring-inset',
          integrity.isBalanced
            ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
            : 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
        ].join(' ')}
        role="status"
      >
        {integrity.isBalanced ? (
          <CheckCircle2 size={17} aria-hidden="true" />
        ) : (
          <XCircle size={17} aria-hidden="true" />
        )}
        <span>
          {integrity.isBalanced
            ? 'Debits equal credits exactly.'
            : `Books are not balanced — out by ${formatCents(
                Math.abs(integrity.totalDebitCents - integrity.totalCreditCents),
              )}.`}
        </span>
      </div>
    </section>
  );
}
