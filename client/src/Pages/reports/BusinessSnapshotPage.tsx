import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Coins, Landmark, PackageMinus, Percent, TrendingUp, Wallet } from 'lucide-react';
import {
  getBusinessSnapshot,
  type BusinessSnapshot,
  type SnapshotRatioKey,
  type SnapshotRatioValue,
} from '../../services/fetchServices';
import { useLedgerSettings } from '../../context/LedgerSettingsContext';
import { fiscalYearBounds } from '../accounting/fiscalYear';
import { formatCents } from '../../utils/money';
import { formatRatio, ratioUnavailableText } from '../../utils/ratio';
import { formatDate, orgToday } from '../../utils/date';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import ExportMenu from '../../components/ui/ExportMenu';
import StatTile from '../../components/ui/StatTile';
import ProfitabilityChart from '../../components/charts/ProfitabilityChart';
import RatioTrendChart from '../../components/charts/RatioTrendChart';
import PositionChart from '../../components/charts/PositionChart';
import AgingStackChart from '../../components/charts/AgingStackChart';

/**
 * Phase 47 — the business snapshot. Every KPI is shown against the period
 * immediately before it (same length), and a 12-month trend sits beneath.
 * Everything is computed from ledger lines on every request.
 */

type Preset = 'month' | 'quarter' | 'ytd' | 'custom';

const NO_VALUE: SnapshotRatioValue = { valueBp: null, reason: null };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function ratioOf(report: BusinessSnapshot, key: SnapshotRatioKey): { current: SnapshotRatioValue; prior: SnapshotRatioValue; kind: 'PERCENT' | 'TIMES' } {
  const found = report.ratios.find((ratio) => ratio.key === key);
  if (found === undefined) return { current: NO_VALUE, prior: NO_VALUE, kind: 'PERCENT' };
  return { current: found.current, prior: found.prior, kind: found.kind };
}

export default function BusinessSnapshotPage() {
  // null means "use the default": the current fiscal year to date.
  const [userFrom, setUserFrom] = useState<string | null>(null);
  const [userTo, setUserTo] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('ytd');
  const [report, setReport] = useState<BusinessSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ledgerSettings = useLedgerSettings();

  const settings = ledgerSettings.status === 'ready' ? ledgerSettings.settings : null;
  const today = orgToday();
  const defaults = fiscalYearBounds(
    settings?.fiscalYearStartMonth ?? 1,
    settings?.fiscalYearStartDay ?? 1,
    today,
  );
  const from = userFrom ?? defaults.startDate;
  const to = userTo ?? today;

  useEffect(() => {
    let ignore = false;
    setError(null);
    getBusinessSnapshot(from === '' ? null : from, to === '' ? null : to)
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the business snapshot');
      });
    return () => {
      ignore = true;
    };
  }, [from, to]);

  function applyPreset(next: Preset) {
    setPreset(next);
    if (next === 'custom') return;
    if (next === 'month') {
      setUserFrom(`${today.slice(0, 8)}01`);
      setUserTo(today);
      return;
    }
    if (next === 'quarter') {
      const year = today.slice(0, 4);
      const month = Number(today.slice(5, 7));
      const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
      setUserFrom(`${year}-${pad2(quarterStartMonth)}-01`);
      setUserTo(today);
      return;
    }
    setUserFrom(defaults.startDate);
    setUserTo(today);
  }

  const selectClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  const grossMargin = report === null ? null : ratioOf(report, 'GROSS_MARGIN');

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/reports" label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="page-title m-0">Business snapshot</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            How the business is performing, and its financial position, computed from ledger lines on every request.
          </p>
        </div>

        <div className="flex items-end gap-4 flex-wrap">
          <ExportMenu path="/reports/business-snapshot" params={{ from: from || null, to: to || null }} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Period</span>
            <select
              aria-label="Period"
              value={preset}
              onChange={(e) => {
                applyPreset(e.target.value as Preset);
              }}
              className={selectClass}
            >
              <option value="month">This month</option>
              <option value="quarter">This quarter</option>
              <option value="ytd">Year to date</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setUserFrom(e.target.value);
                setPreset('custom');
              }}
              className={selectClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setUserTo(e.target.value);
                setPreset('custom');
              }}
              className={selectClass}
            />
          </label>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <LoadingState />}

      {report !== null && grossMargin !== null && (
        <>
          <div className="grid">
            <StatTile
              label="Revenue"
              icon={TrendingUp}
              value={formatCents(report.performance.current.revenueCents)}
              hint={`Prior period ${formatCents(report.performance.prior.revenueCents)}`}
            />
            <StatTile
              label="Cost of sales"
              icon={PackageMinus}
              value={formatCents(report.performance.current.costOfSalesCents)}
              hint={`Prior period ${formatCents(report.performance.prior.costOfSalesCents)}`}
            />
            <StatTile
              label="Gross profit"
              icon={Coins}
              value={formatCents(report.performance.current.grossProfitCents)}
              hint={`Prior period ${formatCents(report.performance.prior.grossProfitCents)}`}
            />
            <StatTile
              label="Gross margin"
              icon={Percent}
              value={formatRatio('PERCENT', grossMargin.current.valueBp)}
              hint={`Prior period ${formatRatio('PERCENT', grossMargin.prior.valueBp)}`}
            />
            <StatTile
              label="Net worth"
              icon={Landmark}
              tone={report.position.current.netWorthCents < 0 ? 'bad' : 'good'}
              value={formatCents(report.position.current.netWorthCents)}
              hint={`Prior period ${formatCents(report.position.prior.netWorthCents)}`}
            />
            <StatTile
              label="Working capital"
              icon={Wallet}
              tone={report.position.current.workingCapitalCents < 0 ? 'bad' : 'good'}
              value={formatCents(report.position.current.workingCapitalCents)}
              hint={`Prior period ${formatCents(report.position.prior.workingCapitalCents)}`}
            />
          </div>

          <div className="card">
            <h3 className="m-0 mb-3 section-title">Profitability — last 12 months</h3>
            <ProfitabilityChart points={report.trend} />
          </div>

          <div className="card">
            <h3 className="m-0 mb-3 section-title">Ratios</h3>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[24rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Ratio</th>
                    <th className="p-3 font-medium text-right">Current</th>
                    <th className="p-3 font-medium text-right">Prior period</th>
                  </tr>
                </thead>
                <tbody>
                  {report.ratios.map((ratio) => (
                    <tr key={ratio.key} className="border-t border-[var(--border)]">
                      <td className="p-3">{ratio.label}</td>
                      <td
                        className="p-3 text-right tabular-nums"
                        title={ratioUnavailableText(ratio.current) ?? undefined}
                      >
                        {formatRatio(ratio.kind, ratio.current.valueBp)}
                      </td>
                      <td
                        className="p-3 text-right tabular-nums"
                        title={ratioUnavailableText(ratio.prior) ?? undefined}
                      >
                        {formatRatio(ratio.kind, ratio.prior.valueBp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4">
              <RatioTrendChart points={report.trend} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card">
              <h3 className="m-0 mb-3 section-title">Financial position</h3>
              <PositionChart position={report.position.current} />
            </div>
            <div className="card">
              <h3 className="m-0 mb-3 section-title">Aged receivables & payables</h3>
              <AgingStackChart receivables={report.receivables} payables={report.payables} />
              <div className="flex gap-4 mt-3 text-sm">
                <Link to="/reports/aged-receivables" className="text-[var(--accent)]">
                  Aged receivables →
                </Link>
                <Link to="/reports/aged-payables" className="text-[var(--accent)]">
                  Aged payables →
                </Link>
              </div>
            </div>
          </div>

          <p className="text-xs text-[var(--muted)]">
            Prior period: {formatDate(report.priorPeriod.from)} – {formatDate(report.priorPeriod.to)}. Fixed assets are
            non-current assets. Accounts are current or non-current by their place in the chart of accounts, or by the
            override in Chart of accounts.
          </p>
        </>
      )}
    </section>
  );
}
