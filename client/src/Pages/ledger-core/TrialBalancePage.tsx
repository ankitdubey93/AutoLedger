import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { getTrialBalance, type AccountType, type TrialBalanceRow } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * The trial balance — the report that proves the books balance.
 *
 * Every figure is aggregated from raw ledger lines on each request. There is no
 * summary table behind this, which is why the number is always current and can
 * never disagree with the entries it came from.
 *
 * `?type=` is a client-side filter over rows already fetched — the server
 * endpoint takes no such parameter and none is added. The footer totals stay
 * unfiltered even while a type filter is active: they are the proof the
 * books balance, and a filtered subtotal would not be that proof, so the
 * label changes instead of the numbers.
 *
 * Every row here is a postable account — reportService.trialBalance filters
 * on `a.is_postable` — so every row has a ledger of its own and the account
 * name is always safely linkable. A header account would return 422 from
 * `GET /:id/ledger` and none can appear in this report.
 */

interface Report {
  rows: TrialBalanceRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  isBalanced: boolean;
}

const FILTERABLE_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;

function readTypeParam(raw: string | null): AccountType | null {
  return raw !== null && (FILTERABLE_TYPES as readonly string[]).includes(raw) ? (raw as AccountType) : null;
}

export default function TrialBalancePage() {
  const base = useAppBasePath();
  const [asOf, setAsOf] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [params, setParams] = useSearchParams();
  const activeType = readTypeParam(params.get('type'));

  useEffect(() => {
    let ignore = false;
    setError(null);

    getTrialBalance(asOf === '' ? null : asOf)
      .then((res) => {
        if (!ignore) setReport(res);
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setError(err instanceof Error ? err.message : 'Could not load the trial balance');
        }
      });

    return () => {
      ignore = true;
    };
  }, [asOf]);

  const visible =
    report === null
      ? []
      : report.rows.filter(
          (row) =>
            (!hideEmpty || row.debitCents !== 0 || row.creditCents !== 0) &&
            (activeType === null || row.type === activeType),
        );

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Trial balance</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Computed from raw ledger lines on every request — no stored balances.
          </p>
        </div>

        <div className="flex items-end gap-4">
          <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={(e) => setHideEmpty(e.target.checked)}
            />
            Hide accounts with no activity
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">As at</span>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
            />
          </label>
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}
      {report === null && error === null && <p className="muted">Loading…</p>}

      {report !== null && (
        <>
          <div
            className={[
              'flex items-center gap-2.5 rounded-lg px-4 py-3 text-sm ring-1 ring-inset',
              report.isBalanced
                ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                : 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
            ].join(' ')}
            role="status"
          >
            {report.isBalanced ? (
              <CheckCircle2 size={17} aria-hidden="true" />
            ) : (
              <XCircle size={17} aria-hidden="true" />
            )}
            <span>
              {report.isBalanced
                ? 'Debits equal credits exactly.'
                : `Out of balance by ${formatCents(
                    Math.abs(report.totalDebitCents - report.totalCreditCents),
                  )} — this should be impossible.`}
            </span>
          </div>

          {activeType !== null && (
            <div className="flex items-center gap-2 text-sm">
              <span className="chip">Type: {activeType}</span>
              <button
                type="button"
                className="btn btn--ghost"
                style={{ marginTop: 0 }}
                onClick={() => {
                  setParams({}, { replace: true });
                }}
              >
                Clear filter
              </button>
            </div>
          )}

          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[34rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Code</th>
                  <th className="p-3 font-medium">Account</th>
                  <th className="p-3 font-medium">Type</th>
                  <th className="p-3 font-medium text-right">Debit</th>
                  <th className="p-3 font-medium text-right">Credit</th>
                  <th className="p-3 font-medium text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
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
                    <td className="p-3 text-[var(--muted)]">{row.type}</td>
                    <td className="p-3 text-right tabular-nums">
                      {row.debitCents > 0 ? formatCents(row.debitCents) : ''}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {row.creditCents > 0 ? formatCents(row.creditCents) : ''}
                    </td>
                    {/* Type-aware: positive means "normal side" for this account
                        type, so revenue does not read as negative income. */}
                    <td className="p-3 text-right tabular-nums font-medium">
                      {formatCents(row.netBalanceCents)}
                    </td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr className="border-t border-[var(--border)]">
                    <td colSpan={6} className="p-4 text-center text-[var(--muted)]">
                      No activity yet.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[var(--border)] font-semibold">
                  <td className="p-3" colSpan={3}>
                    {activeType === null ? 'Totals' : 'Totals — all accounts'}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {formatCents(report.totalDebitCents)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {formatCents(report.totalCreditCents)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
