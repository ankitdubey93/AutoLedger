import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Banknote,
  CheckCircle2,
  CreditCard,
  PiggyBank,
  TrendingDown,
  TrendingUp,
  Wallet,
  XCircle,
} from 'lucide-react';
import { useOrg } from '../../context/OrgContext';
import { getLedgerDashboard, type DashboardSummary } from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { formatCents } from '../../utils/money';
import TrendChart from './TrendChart';
import MetricTile from './MetricTile';
import EquationBar from './EquationBar';
import ProportionBar from './ProportionBar';
import BarChart from './BarChart';

/**
 * LedgerCore's home page. Every figure is aggregated from raw `ledger_lines`
 * on each request — the same "no summary table" rule `TrialBalancePage`
 * states for its own report.
 *
 * The four position tiles are links into the trial balance filtered by
 * account type (`TrialBalancePage`'s `?type=`) — the only real drilldown
 * destination that exists today. A per-account ledger detail page would be
 * the ideal target and does not exist; that is a separate future plan, not
 * Phase 4 either.
 */

function entryTotalCents(lines: { debitCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.debitCents, 0);
}

export default function DashboardPage() {
  const { organization } = useOrg();
  const base = useAppBasePath();
  const currency = organization?.baseCurrency ?? '';
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

  const { position, performance, activity, integrity, trend, fiscalYear, receivables, payables } = dashboard;

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
        <MetricTile
          label="Assets"
          valueCents={position.assetsCents}
          currency={currency}
          icon={Wallet}
          tone="neutral"
          to={`${base}/trial-balance?type=Asset`}
          hint={null}
        />
        <MetricTile
          label="Liabilities"
          valueCents={position.liabilitiesCents}
          currency={currency}
          icon={CreditCard}
          tone="neutral"
          to={`${base}/trial-balance?type=Liability`}
          hint={null}
        />
        <MetricTile
          label="Equity"
          valueCents={position.equityCents}
          currency={currency}
          icon={PiggyBank}
          tone="neutral"
          to={`${base}/trial-balance?type=Equity`}
          hint={null}
        />
        <MetricTile
          label="Cash"
          valueCents={position.cashCents}
          currency={currency}
          icon={Banknote}
          tone="good"
          to={position.cashCents === null ? `${base}/settings` : `${base}/trial-balance?type=Asset`}
          hint={
            position.cashCents === null ? 'No cash account configured — set one in Settings.' : null
          }
        />
      </div>

      <div className="card">
        <p className="text-sm font-medium m-0 mb-3">Accounting equation</p>
        <EquationBar
          assetsCents={position.assetsCents}
          liabilitiesCents={position.liabilitiesCents}
          equityCents={position.equityCents}
          currentEarningsCents={position.currentEarningsCents}
          currency={currency}
          holds={position.equationHolds}
        />
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
                className="m-0 tabular-nums flex items-center gap-1.5 justify-end"
                style={{ color: performance.yearToDate.netIncomeCents < 0 ? 'var(--bad)' : undefined }}
              >
                {performance.yearToDate.netIncomeCents < 0 ? (
                  <TrendingDown size={15} aria-hidden="true" />
                ) : (
                  <TrendingUp size={15} aria-hidden="true" />
                )}
                {formatCents(performance.yearToDate.netIncomeCents)}
              </dd>
            </div>
          </dl>
          <div className="mt-3">
            <ProportionBar
              segments={[
                { label: 'Revenue', valueCents: performance.yearToDate.revenueCents, color: 'var(--good)' },
                { label: 'Expenses', valueCents: performance.yearToDate.expenseCents, color: 'var(--bad)' },
              ]}
              currency={currency}
            />
          </div>
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
                className="m-0 tabular-nums flex items-center gap-1.5 justify-end"
                style={{ color: performance.currentMonth.netIncomeCents < 0 ? 'var(--bad)' : undefined }}
              >
                {performance.currentMonth.netIncomeCents < 0 ? (
                  <TrendingDown size={15} aria-hidden="true" />
                ) : (
                  <TrendingUp size={15} aria-hidden="true" />
                )}
                {formatCents(performance.currentMonth.netIncomeCents)}
              </dd>
            </div>
          </dl>
          <div className="mt-3">
            <ProportionBar
              segments={[
                { label: 'Revenue', valueCents: performance.currentMonth.revenueCents, color: 'var(--good)' },
                { label: 'Expenses', valueCents: performance.currentMonth.expenseCents, color: 'var(--bad)' },
              ]}
              currency={currency}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <p className="text-sm font-medium m-0 mb-1">Invoices owed to you</p>
          <p className="text-2xl font-semibold m-0 mt-1 tabular-nums">
            {formatCents(receivables.outstandingCents)}{' '}
            <span className="text-xs font-normal text-[var(--muted)]">{currency}</span>
          </p>
          <dl className="flex flex-col gap-1 text-sm mt-3">
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">
                <Link to={`${base}/invoices?status=ISSUED&settlement=OUTSTANDING`}>Awaiting payment</Link>
              </dt>
              <dd className="m-0 tabular-nums">
                {formatCents(receivables.outstandingCents - receivables.overdueCents)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">
                <Link to={`${base}/invoices?status=ISSUED&settlement=OVERDUE`}>Overdue</Link>
              </dt>
              <dd className="m-0 tabular-nums" style={{ color: receivables.overdueCents > 0 ? 'var(--bad)' : undefined }}>
                {formatCents(receivables.overdueCents)}
              </dd>
            </div>
          </dl>
          {receivables.draftCount > 0 && (
            <p className="text-xs text-[var(--muted)] m-0 mt-2">
              <Link to={`${base}/invoices?status=DRAFT`}>
                {receivables.draftCount} draft {receivables.draftCount === 1 ? 'invoice' : 'invoices'}
              </Link>
            </p>
          )}
          <div className="mt-3">
            <BarChart
              accessibleTitle="Receivables by age"
              data={receivables.buckets.map((b, i) => ({
                label: b.label,
                amountCents: b.amountCents,
                emphasis: i > 0,
              }))}
            />
          </div>
        </div>

        <div className="card">
          <p className="text-sm font-medium m-0 mb-1">Bills you need to pay</p>
          <p className="text-2xl font-semibold m-0 mt-1 tabular-nums">
            {formatCents(payables.outstandingCents)}{' '}
            <span className="text-xs font-normal text-[var(--muted)]">{currency}</span>
          </p>
          <dl className="flex flex-col gap-1 text-sm mt-3">
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">
                <Link to={`${base}/bills?status=POSTED&settlement=OUTSTANDING`}>Awaiting payment</Link>
              </dt>
              <dd className="m-0 tabular-nums">
                {formatCents(payables.outstandingCents - payables.overdueCents)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">
                <Link to={`${base}/bills?status=POSTED&settlement=OVERDUE`}>Overdue</Link>
              </dt>
              <dd className="m-0 tabular-nums" style={{ color: payables.overdueCents > 0 ? 'var(--bad)' : undefined }}>
                {formatCents(payables.overdueCents)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">
                <Link to={`${base}/bills?status=AWAITING_APPROVAL`}>To review</Link>
              </dt>
              <dd className="m-0 tabular-nums">{formatCents(payables.awaitingReviewCents)}</dd>
            </div>
          </dl>
          <p className="text-xs text-[var(--muted)] m-0 mt-2">Bills entered but not yet approved.</p>
          {payables.draftCount > 0 && (
            <p className="text-xs text-[var(--muted)] m-0 mt-1">
              <Link to={`${base}/bills?status=DRAFT`}>
                {payables.draftCount} draft {payables.draftCount === 1 ? 'bill' : 'bills'}
              </Link>
            </p>
          )}
          <div className="mt-3">
            <BarChart
              accessibleTitle="Payables by age"
              data={payables.buckets.map((b, i) => ({
                label: b.label,
                amountCents: b.amountCents,
                emphasis: i > 0,
              }))}
            />
          </div>
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
