import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getCashFlow,
  type CashFlowCashAccount,
  type CashFlowRow,
  type CashFlowStatement,
} from '../../services/fetchServices';
import { useLedgerSettings } from '../../context/LedgerSettingsContext';
import { fiscalYearBounds } from '../accounting/fiscalYear';
import { formatCents } from '../../utils/money';
import BackLink from '../../components/BackLink';
import LoadingState from '../../components/ui/LoadingState';
import ExportMenu from '../../components/ui/ExportMenu';

/**
 * Cash flow statement — the indirect method. It starts from net income and
 * adds back the non-cash movements in each balance-sheet account, grouped into
 * operating, investing and financing activities. The server derives every
 * account's section; a row marked "(override)" has a category set by hand in
 * Chart of accounts.
 *
 * The default period is the current fiscal year to date, matching the
 * server's own default.
 */

function CashRow({ row }: { row: CashFlowRow }) {
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="p-3 font-mono text-xs text-[var(--muted)]">{row.code}</td>
      <td className="p-3 pl-6">
        <Link to={`/accounts/${row.accountId}`} className="text-[var(--text)] no-underline hover:underline">
          {row.name}
        </Link>
        {row.categorySource === 'OVERRIDE' && (
          <span className="ml-2 text-xs text-[var(--muted)]">(override)</span>
        )}
      </td>
      <td className="p-3 text-right tabular-nums">{formatCents(row.amountCents)}</td>
    </tr>
  );
}

function HeadingRow({ label }: { label: string }) {
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="p-3 font-semibold text-[var(--muted)]" colSpan={3}>
        {label}
      </td>
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

function DetailRow({ label, amountCents }: { label: string; amountCents: number }) {
  return (
    <tr className="border-t border-[var(--border)]">
      <td className="p-3 pl-6" colSpan={2}>
        {label}
      </td>
      <td className="p-3 text-right tabular-nums">{formatCents(amountCents)}</td>
    </tr>
  );
}

function CashAccountsTable({ accounts }: { accounts: CashFlowCashAccount[] }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
      <table className="w-full border-collapse text-sm min-w-[30rem]">
        <thead>
          <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
            <th className="p-3 font-medium">Code</th>
            <th className="p-3 font-medium">Account</th>
            <th className="p-3 font-medium text-right">Opening</th>
            <th className="p-3 font-medium text-right">Closing</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.accountId} className="border-t border-[var(--border)]">
              <td className="p-3 font-mono text-xs text-[var(--muted)]">{account.code}</td>
              <td className="p-3">
                <Link
                  to={`/accounts/${account.accountId}`}
                  className="text-[var(--text)] no-underline hover:underline"
                >
                  {account.name}
                </Link>
              </td>
              <td className="p-3 text-right tabular-nums">{formatCents(account.openingCents)}</td>
              <td className="p-3 text-right tabular-nums">{formatCents(account.closingCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CashFlowPage() {
  // null means "use the default": the current fiscal year to date.
  const [userFrom, setUserFrom] = useState<string | null>(null);
  const [userTo, setUserTo] = useState<string | null>(null);
  const [report, setReport] = useState<CashFlowStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ledgerSettings = useLedgerSettings();

  const settings = ledgerSettings.status === 'ready' ? ledgerSettings.settings : null;
  const today = new Date().toISOString().slice(0, 10);
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
    getCashFlow(from === '' ? null : from, to === '' ? null : to)
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the cash flow statement');
      });
    return () => {
      ignore = true;
    };
  }, [from, to]);

  const selectClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      <BackLink to="/reports" label="Back to reports" />

      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Cash flow statement</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Indirect method, computed from ledger lines on every request.
          </p>
        </div>

        <div className="flex items-end gap-4">
          <ExportMenu path="/reports/cash-flow" params={{ from: from || null, to: to || null }} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setUserFrom(e.target.value)}
              className={selectClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setUserTo(e.target.value)}
              className={selectClass}
            />
          </label>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <LoadingState />}

      {report !== null && (
        <>
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
                <HeadingRow label="Operating activities" />
                <DetailRow label="Net income" amountCents={report.netIncomeCents} />
                {report.operating.rows.map((row) => (
                  <CashRow key={row.accountId} row={row} />
                ))}
                <SubtotalRow
                  label="Net cash from operating activities"
                  amountCents={report.operating.totalCents}
                />

                <HeadingRow label="Investing activities" />
                {report.investing.rows.map((row) => (
                  <CashRow key={row.accountId} row={row} />
                ))}
                <SubtotalRow
                  label="Net cash from investing activities"
                  amountCents={report.investing.totalCents}
                />

                <HeadingRow label="Financing activities" />
                {report.financing.rows.map((row) => (
                  <CashRow key={row.accountId} row={row} />
                ))}
                <SubtotalRow
                  label="Net cash from financing activities"
                  amountCents={report.financing.totalCents}
                />
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[var(--border)] font-semibold">
                  <td className="p-3" colSpan={2}>
                    Net change in cash
                  </td>
                  <td className="p-3 text-right tabular-nums">{formatCents(report.netChangeCents)}</td>
                </tr>
                <DetailRow label="Cash at beginning of period" amountCents={report.openingCashCents} />
                <DetailRow label="Cash at end of period" amountCents={report.closingCashCents} />
              </tfoot>
            </table>
          </div>

          <h3 className="text-sm font-semibold m-0">Cash accounts</h3>
          <CashAccountsTable accounts={report.cashAccounts} />
        </>
      )}
    </section>
  );
}
