import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiRequestError, getAccountLedger, type AccountLedger } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import { TYPE_STYLES } from './AccountsPage';
import BackLink from '../../components/BackLink';

/**
 * One postable account's ledger — opening balance, every posted line with a
 * running balance, period totals, closing balance. The standard "account
 * detail" view every accounting application (Xero, QuickBooks Online) offers
 * from its chart of accounts.
 *
 * The running balance is computed server-side, by a window function over the
 * whole filtered set — this page only renders what it's given. See
 * study/postgresql/window-functions-and-running-totals.md.
 */

const PAGE_LIMIT = 50;

export default function AccountLedgerPage() {
  const { accountId } = useParams<{ accountId: string }>();
  const base = useAppBasePath();
  const [params, setParams] = useSearchParams();

  const [ledger, setLedger] = useState<AccountLedger | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [notFound, setNotFound] = useState(false);
  const [headerAccount, setHeaderAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    if (accountId === undefined) return;
    let ignore = false;
    setError(null);
    setNotFound(false);
    setHeaderAccount(null);

    const filters: { from?: string; to?: string; page: number; limit: number } = {
      page,
      limit: PAGE_LIMIT,
    };
    if (from !== '') filters.from = from;
    if (to !== '') filters.to = to;

    getAccountLedger(accountId, filters)
      .then((res) => {
        if (ignore) return;
        setLedger(res);
        setTotalPages(res.totalPages);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotFound(true);
        } else if (err instanceof ApiRequestError && err.status === 422) {
          setHeaderAccount(err.message);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load the account ledger');
        }
      });

    return () => {
      ignore = true;
    };
  }, [accountId, from, to, page]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next);
  }

  function clearFilters() {
    setParams({});
  }

  function goToPage(next: number) {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete('page');
    else nextParams.set('page', String(next));
    setParams(nextParams);
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`${base}/accounts`} label="Back to chart of accounts" />
        <p className="status status--bad">Account not found.</p>
      </section>
    );
  }

  if (headerAccount !== null) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to={`${base}/accounts`} label="Back to chart of accounts" />
        <p className="status status--bad">{headerAccount}</p>
        <p className="muted">
          Header accounts roll up their children; open a postable account to see its ledger.
        </p>
      </section>
    );
  }

  if (error !== null) {
    return <p className="status status--bad">{error}</p>;
  }

  if (ledger === null) {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading ledger…</span>
      </div>
    );
  }

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      <BackLink to={`${base}/accounts`} label="Back to chart of accounts" />

      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2.5 mt-1">
          <h2 className="text-lg font-semibold m-0">
            {ledger.account.code} · {ledger.account.name}
          </h2>
          <span
            className={[
              'text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset shrink-0',
              TYPE_STYLES[ledger.account.type] ?? '',
            ].join(' ')}
          >
            {ledger.account.type}
          </span>
        </div>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Opening balance</p>
          <p className="text-lg font-semibold tabular-nums m-0 mt-1">
            {formatCents(ledger.openingBalanceCents)}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Total debits</p>
          <p className="text-lg font-semibold tabular-nums m-0 mt-1">
            {formatCents(ledger.periodDebitCents)}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Total credits</p>
          <p className="text-lg font-semibold tabular-nums m-0 mt-1">
            {formatCents(ledger.periodCreditCents)}
          </p>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)] m-0">Closing balance</p>
          <p className="text-lg font-semibold tabular-nums m-0 mt-1">
            {formatCents(ledger.closingBalanceCents)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFilter('from', e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setFilter('to', e.target.value)}
            className={inputClass}
          />
        </label>
        {(from !== '' || to !== '') && (
          <button type="button" onClick={clearFilters} className="btn btn--ghost">
            Clear
          </button>
        )}
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[48rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Date</th>
              <th className="p-3 font-medium">Description</th>
              <th className="p-3 font-medium">Split</th>
              <th className="p-3 font-medium">Reference</th>
              <th className="p-3 font-medium text-right">Debit</th>
              <th className="p-3 font-medium text-right">Credit</th>
              <th className="p-3 font-medium text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {ledger.openingBalanceCents !== 0 && (
              <tr className="border-t border-[var(--border)] italic text-[var(--muted)]">
                <td className="p-3" colSpan={6}>
                  Opening balance
                </td>
                <td className="p-3 text-right tabular-nums">
                  {formatCents(ledger.openingBalanceCents)}
                </td>
              </tr>
            )}
            {ledger.rows.map((row) => (
              <tr key={row.lineId} className="border-t border-[var(--border)]">
                <td className="p-3 tabular-nums whitespace-nowrap">{row.entryDate}</td>
                <td className="p-3">
                  <Link to={`${base}/journals/${row.entryId}`}>{row.description ?? '—'}</Link>
                </td>
                <td className="p-3 font-mono text-xs text-[var(--muted)]">
                  {row.counterparts.join(', ') || '—'}
                </td>
                <td className="p-3 font-mono text-xs">
                  <Link
                    to={`${base}/journals/${row.entryId}`}
                    className="text-[var(--muted)] hover:text-[var(--text)]"
                    title="Open the journal entry this line was posted in"
                  >
                    {row.entryId.slice(0, 8)}
                  </Link>
                </td>
                <td className="p-3 text-right tabular-nums">
                  {row.debitCents > 0 ? formatCents(row.debitCents) : ''}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {row.creditCents > 0 ? formatCents(row.creditCents) : ''}
                </td>
                <td className="p-3 text-right tabular-nums font-medium">
                  {formatCents(row.runningBalanceCents)}
                </td>
              </tr>
            ))}
            {ledger.rows.length === 0 && (
              <tr className="border-t border-[var(--border)]">
                <td colSpan={7} className="p-4 text-center text-[var(--muted)]">
                  No activity in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {ledger.totalCount > 0 && (
        <div className="flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
          <span>
            Showing {ledger.rows.length} of {ledger.totalCount}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={page <= 1}
              onClick={() => goToPage(page - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={page >= totalPages}
              onClick={() => goToPage(page + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
