import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getBalanceSheet, type BalanceSheet, type StatementRow } from '../../services/fetchServices';
import { formatCents } from './money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import BackLink from './BackLink';

/**
 * Balance sheet — Assets = Liabilities + Equity as at a chosen date.
 * Aggregated from raw ledger lines on every request, same discipline as the
 * trial balance and P&L.
 *
 * Retained earnings and current-period earnings are DERIVED, not read from
 * account 3200 — LedgerCore posts no year-end closing entry. Both are shown
 * as explicit equity rows carrying a `derived` marker so a reader never
 * mistakes them for posted account balances.
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

function DerivedRow({ label, amountCents }: { label: string; amountCents: number }) {
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="p-3 text-[var(--muted)]" colSpan={2}>
        <span className="inline-flex items-center gap-2">
          {label}
          <span className="chip chip--muted">derived</span>
        </span>
      </td>
      <td className="p-3 text-right tabular-nums">{formatCents(amountCents)}</td>
    </tr>
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

export default function BalanceSheetPage() {
  const base = useAppBasePath();
  const [asOf, setAsOf] = useState('');
  const [report, setReport] = useState<BalanceSheet | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    setError(null);

    getBalanceSheet(asOf === '' ? null : asOf)
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : 'Could not load the balance sheet');
        }
      });

    return () => {
      ignore = true;
    };
  }, [asOf]);

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/reports`} label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Balance sheet</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Computed from raw ledger lines on every request — no stored balances.
          </p>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">As at</span>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
          />
        </label>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <p className="muted">Loading…</p>}

      {report !== null && (
        <>
          <div
            className={[
              'flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm ring-1 ring-inset',
              report.balances
                ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                : 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
            ].join(' ')}
            role="status"
          >
            {report.balances ? (
              <CheckCircle2 size={17} aria-hidden="true" />
            ) : (
              <XCircle size={17} aria-hidden="true" />
            )}
            <span>
              {report.balances
                ? 'Assets equal liabilities plus equity exactly.'
                : `Out of balance by ${formatCents(
                    Math.abs(report.assets.totalCents - report.totalLiabilitiesAndEquityCents),
                  )} — this should be impossible.`}
            </span>
          </div>

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
                    Assets
                  </td>
                </tr>
                <SectionRows rows={report.assets.rows} base={base} />
                <SubtotalRow label="Total assets" amountCents={report.assets.totalCents} />

                <tr className="border-t border-[var(--border)]">
                  <td className="p-3 font-semibold text-[var(--muted)]" colSpan={3}>
                    Liabilities
                  </td>
                </tr>
                <SectionRows rows={report.liabilities.rows} base={base} />
                <SubtotalRow label="Total liabilities" amountCents={report.liabilities.totalCents} />

                <tr className="border-t border-[var(--border)]">
                  <td className="p-3 font-semibold text-[var(--muted)]" colSpan={3}>
                    Equity
                  </td>
                </tr>
                <SectionRows rows={report.equity.rows} base={base} />
                <DerivedRow
                  label="Retained earnings (prior years)"
                  amountCents={report.equity.retainedEarningsCents}
                />
                <DerivedRow
                  label="Current period earnings"
                  amountCents={report.equity.currentEarningsCents}
                />
                <SubtotalRow label="Total equity" amountCents={report.equity.totalCents} />
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[var(--border)] font-semibold">
                  <td className="p-3" colSpan={2}>
                    Total liabilities &amp; equity
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {formatCents(report.totalLiabilitiesAndEquityCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
