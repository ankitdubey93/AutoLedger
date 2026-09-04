import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  listBankTransactions,
  matchBankTransaction,
  unmatchBankTransaction,
  ignoreBankTransaction,
  unignoreBankTransaction,
  rescoreBankTransaction,
  type BankTransaction,
  type BankTransactionStatus,
} from '../../services/fetchServices';
import { formatCents } from './money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import ConfirmDialog from './ConfirmDialog';
import MatchScoreBadge from './MatchScoreBadge';

/**
 * The bank-line approval queue. Every unmatched line's top candidates are
 * shown inline with their score breakdown — a suggestion must be
 * explainable on screen, not just a number (docs/ledger-core.md § C).
 *
 * Accepting a suggestion at or above the auto-match threshold acts
 * immediately; below it, or matching by hand, is gated by ConfirmDialog,
 * matching every other one-way action in LedgerCore. Unmatch is the one
 * action that undoes a GL posting (it voids the payment the match
 * created), so it is always gated.
 */

const PAGE_LIMIT = 50;
const AUTO_MATCH_THRESHOLD = 85;

const TABS: Array<{ label: string; value: BankTransactionStatus | '' }> = [
  { label: 'All', value: '' },
  { label: 'Unmatched', value: 'UNMATCHED' },
  { label: 'Matched', value: 'MATCHED' },
  { label: 'Ignored', value: 'IGNORED' },
];

interface PendingConfirm {
  kind: 'match' | 'unmatch';
  transactionId: string;
  suggestionId?: string;
}

export default function BankTransactionsPage() {
  const base = useAppBasePath();
  const [params, setParams] = useSearchParams();
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const status = (params.get('status') ?? '') as BankTransactionStatus | '';
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    let ignore = false;
    setError(null);

    const filters: Parameters<typeof listBankTransactions>[0] = { page, limit: PAGE_LIMIT };
    if (status !== '') filters.status = status;
    if (q !== '') filters.q = q;

    listBankTransactions(filters)
      .then((res) => {
        if (ignore) return;
        setTransactions(res.transactions);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load bank lines');
      });

    return () => {
      ignore = true;
    };
  }, [status, q, page, reloadToken]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next);
  }

  function goToPage(next: number) {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete('page');
    else nextParams.set('page', String(next));
    setParams(nextParams);
  }

  async function runAction(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusyId(id);
    setRowError(null);
    try {
      await action();
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setRowError({ id, message: err instanceof Error ? err.message : 'That action failed' });
    } finally {
      setBusyId(null);
    }
  }

  function handleAccept(transactionId: string, suggestionId: string, score: number) {
    if (score >= AUTO_MATCH_THRESHOLD) {
      void runAction(transactionId, () => matchBankTransaction(transactionId, { suggestionId, invoiceId: null, billId: null }));
    } else {
      setConfirm({ kind: 'match', transactionId, suggestionId });
    }
  }

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Bank lines</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Imported statement lines, scored against open invoices and bills.
          </p>
        </div>
        <Link
          to={`${base}/bank/import`}
          className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] no-underline"
        >
          Import statement
        </Link>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={status === tab.value}
              onClick={() => setFilter('status', tab.value)}
              className={[
                'px-3 py-1.5 rounded-md text-sm border-0 cursor-pointer',
                status === tab.value ? 'bg-[var(--text)] text-[var(--bg)]' : 'bg-transparent text-[var(--muted)]',
              ].join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Search</span>
          <input
            type="text"
            value={q}
            onChange={(e) => setFilter('q', e.target.value)}
            placeholder="Description or reference"
            className={inputClass}
          />
        </label>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {!loaded && error === null && <p className="muted">Loading…</p>}

      {loaded && (
        <>
          {totalCount === 0 ? (
            <p className="muted">
              No bank lines yet. <Link to={`${base}/bank/import`}>Import a statement</Link> to get started.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {transactions.map((txn) => {
                const isExpanded = expandedId === txn.id;
                const busy = busyId === txn.id;
                return (
                  <div key={txn.id} className="rounded-lg border border-[var(--border)] bg-[var(--panel)]">
                    <div className="flex items-center gap-3 p-3 flex-wrap">
                      <span className="tabular-nums text-sm whitespace-nowrap">{txn.txnDate}</span>
                      <span className="text-sm flex-1 min-w-40">{txn.description}</span>
                      <span
                        className={`tabular-nums text-sm ${txn.amountCents > 0 ? 'text-[var(--good)]' : ''}`}
                      >
                        {formatCents(txn.amountCents)}
                      </span>
                      <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] w-20">
                        {txn.status}
                      </span>
                      <div className="flex items-center gap-2 ml-auto">
                        {txn.status === 'UNMATCHED' && txn.suggestions.length === 0 && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void runAction(txn.id, () => rescoreBankTransaction(txn.id))}
                            className="btn btn--ghost"
                          >
                            Rescore
                          </button>
                        )}
                        {txn.status === 'UNMATCHED' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void runAction(txn.id, () => ignoreBankTransaction(txn.id))}
                            className="btn btn--ghost"
                          >
                            Ignore
                          </button>
                        )}
                        {txn.status === 'IGNORED' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void runAction(txn.id, () => unignoreBankTransaction(txn.id))}
                            className="btn btn--ghost"
                          >
                            Un-ignore
                          </button>
                        )}
                        {txn.status === 'MATCHED' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirm({ kind: 'unmatch', transactionId: txn.id })}
                            className="btn btn--ghost"
                          >
                            Unmatch
                          </button>
                        )}
                        {txn.status === 'UNMATCHED' && txn.suggestions.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : txn.id)}
                            className="btn btn--ghost"
                          >
                            {isExpanded ? 'Hide matches' : `${txn.suggestions.length} suggestion(s)`}
                          </button>
                        )}
                      </div>
                    </div>

                    {rowError !== null && rowError.id === txn.id && (
                      <p className="status status--bad px-3 pb-2 m-0">{rowError.message}</p>
                    )}

                    {isExpanded && txn.suggestions.length > 0 && (
                      <div className="border-t border-[var(--border)] p-3 flex flex-col gap-2">
                        {txn.suggestions.map((suggestion) => (
                          <div
                            key={suggestion.id}
                            className="flex items-center gap-3 flex-wrap rounded-md bg-[var(--bg)] p-2.5"
                          >
                            <MatchScoreBadge score={suggestion.score} />
                            <div className="flex-1 min-w-40">
                              <p className="text-sm m-0">
                                {suggestion.documentReference} · {suggestion.counterpartyName}
                              </p>
                              <p className="text-xs text-[var(--muted)] m-0 mt-0.5">
                                {suggestion.scoreBreakdown.amount.reason} ·{' '}
                                {suggestion.scoreBreakdown.date.reason} ·{' '}
                                {suggestion.scoreBreakdown.counterparty.reason}
                              </p>
                            </div>
                            <span className="tabular-nums text-sm">
                              {formatCents(suggestion.documentAmountDueCents)} due
                            </span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleAccept(txn.id, suggestion.id, suggestion.score)}
                              className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
                            >
                              {suggestion.score >= AUTO_MATCH_THRESHOLD ? 'Accept' : 'Match'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {totalCount > 0 && (
            <div className="flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
              <span>
                Showing {transactions.length} of {totalCount}
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
        </>
      )}

      {confirm !== null && confirm.kind === 'match' && (
        <ConfirmDialog
          title="Match this bank line?"
          body="This posts a payment against the selected document."
          confirmLabel="Match"
          busy={busyId === confirm.transactionId}
          onConfirm={() => {
            const { transactionId, suggestionId } = confirm;
            setConfirm(null);
            if (suggestionId === undefined) return;
            void runAction(transactionId, () =>
              matchBankTransaction(transactionId, { suggestionId, invoiceId: null, billId: null }),
            );
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {confirm !== null && confirm.kind === 'unmatch' && (
        <ConfirmDialog
          title="Unmatch this bank line?"
          body="This voids the payment this match created and posts a reversing entry."
          confirmLabel="Unmatch"
          tone="danger"
          busy={busyId === confirm.transactionId}
          onConfirm={() => {
            const { transactionId } = confirm;
            setConfirm(null);
            void runAction(transactionId, () => unmatchBankTransaction(transactionId));
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
