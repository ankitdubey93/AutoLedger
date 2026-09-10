import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Copy, Eye, Plus, RotateCcw } from 'lucide-react';
import {
  listAccounts,
  listJournals,
  reverseJournal,
  type Account,
  type JournalEntry,
  type JournalFilters,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * The journal register — every posted entry, filterable and paginated.
 *
 * Filters live in the URL via useSearchParams rather than local state, so the
 * register is linkable and survives a reload — the same idiom TrialBalancePage
 * uses for `?type=`. Unlike that page's client-side filter, these filters are
 * server-side: the server holds the full history, not just one page of it.
 *
 * Each row offers View, Duplicate and Reverse. There is no edit and never
 * will be — a posted entry is immutable (guardrails rule 6), enforced again
 * by a database trigger. Duplicate opens the post form pre-filled from this
 * entry (`journals/new?copyFrom=<id>`); Reverse posts the offsetting entry
 * directly, mirroring JournalDetailPage's own `canReverse` rule so the two
 * surfaces never disagree about which entries are correctable.
 */

const PAGE_LIMIT = 50;

function pill(label: string, tone: 'amber' | 'muted') {
  if (tone === 'muted') {
    return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</span>;
  }
  return (
    <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
      {label}
    </span>
  );
}

function accountSummary(entry: JournalEntry): string {
  const codes = [...new Set(entry.lines.map((l) => l.accountCode))];
  const shown = codes.slice(0, 3).join(', ');
  return codes.length > 3 ? `${shown} +${String(codes.length - 3)}` : shown;
}

export default function JournalsPage() {
  const base = useAppBasePath();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<JournalEntry | null>(null);

  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const accountId = params.get('accountId') ?? '';
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? '1');
  const anyFilterSet = from !== '' || to !== '' || accountId !== '' || q !== '';

  useEffect(() => {
    let ignore = false;

    listAccounts()
      .then((res) => {
        if (!ignore) setAccounts(res.accounts.filter((a) => a.isPostable));
      })
      .catch(() => {
        // Non-fatal — the account filter simply stays empty.
      });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    setError(null);

    const filters: JournalFilters = { page, limit: PAGE_LIMIT };
    if (from !== '') filters.from = from;
    if (to !== '') filters.to = to;
    if (accountId !== '') filters.accountId = accountId;
    if (q !== '') filters.q = q;

    listJournals(filters)
      .then((res) => {
        if (ignore) return;
        setEntries(res.entries);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load journal entries');
      });

    return () => {
      ignore = true;
    };
  }, [from, to, accountId, q, page]);

  async function handleReverse(entryId: string) {
    setReversingId(entryId);
    setActionError(null);
    try {
      const { entry: reversal } = await reverseJournal(entryId);
      navigate(`${base}/journals/${reversal.id}`);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Could not reverse the entry');
      setReversingId(null);
    }
  }

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

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Journal entries</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Every entry ever posted. Append-only — a correction is a reversing entry, never an
            edit.
          </p>
        </div>
        <Link
          to={`${base}/journals/new`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--text)] text-[var(--bg)]"
        >
          <Plus size={15} /> New entry
        </Link>
      </header>

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
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Account</span>
          <select
            value={accountId}
            onChange={(e) => setFilter('accountId', e.target.value)}
            className={inputClass}
          >
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Search description</span>
          <input
            type="text"
            value={q}
            onChange={(e) => setFilter('q', e.target.value)}
            aria-label="Search description"
            placeholder="AWS"
            className={inputClass}
          />
        </label>
        {anyFilterSet && (
          <button type="button" onClick={clearFilters} className="btn btn--ghost">
            Clear filters
          </button>
        )}
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
      {actionError !== null && <p className="status status--bad">{actionError}</p>}
      {!loaded && error === null && <p className="muted">Loading…</p>}

      {loaded && (
        <>
          {totalCount === 0 ? (
            <p className="muted">
              {anyFilterSet ? 'No entries match these filters.' : 'Nothing posted yet.'}
            </p>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[48rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Date</th>
                    <th className="p-3 font-medium">Reference</th>
                    <th className="p-3 font-medium">Description</th>
                    <th className="p-3 font-medium">Account(s)</th>
                    <th className="p-3 font-medium">Posted by</th>
                    <th className="p-3 font-medium text-right">Amount</th>
                    <th className="p-3 font-medium">Status</th>
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-t border-[var(--border)]">
                      <td className="p-3 tabular-nums whitespace-nowrap">{entry.entryDate}</td>
                      <td className="p-3 font-mono text-xs text-[var(--muted)]">
                        {entry.id.slice(0, 8)}
                      </td>
                      <td className="p-3">{entry.description ?? '—'}</td>
                      <td className="p-3 font-mono text-xs text-[var(--muted)]">
                        {accountSummary(entry)}
                      </td>
                      <td className="p-3">{entry.createdByName ?? entry.createdByEmail ?? '—'}</td>
                      <td className="p-3 text-right tabular-nums">
                        {formatCents(entry.totalDebitCents)}
                      </td>
                      <td className="p-3">
                        {entry.reversesEntryId !== null
                          ? pill('Reversal', 'amber')
                          : entry.reversedByEntryId !== null
                            ? pill('Reversed', 'amber')
                            : pill('Posted', 'muted')}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            to={`${base}/journals/${entry.id}`}
                            aria-label="View entry"
                            title="View entry"
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs no-underline text-[var(--muted)] hover:text-[var(--text)] border border-[var(--border)]"
                          >
                            <Eye size={14} aria-hidden="true" /> View
                          </Link>
                          <Link
                            to={`${base}/journals/new?copyFrom=${entry.id}`}
                            aria-label="Duplicate entry"
                            title="Copy into a new entry — a posted entry can never be edited"
                            className="p-1.5 rounded-md text-[var(--muted)] hover:text-[var(--text)] border border-transparent"
                          >
                            <Copy size={14} aria-hidden="true" />
                          </Link>
                          {entry.reversesEntryId === null && entry.reversedByEntryId === null && (
                            <button
                              type="button"
                              onClick={() => setConfirmEntry(entry)}
                              disabled={reversingId !== null}
                              aria-label="Reverse entry"
                              title="Post the offsetting entry — the only correction path"
                              className="p-1.5 rounded-md bg-transparent border border-transparent cursor-pointer text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-40"
                            >
                              <RotateCcw size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalCount > 0 && (
            <div className="flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
              <span>
                Showing {entries.length} of {totalCount}
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

      {confirmEntry !== null && (
        <ConfirmDialog
          title="Reverse this entry?"
          body={
            <>
              This posts a new offsetting entry dated {confirmEntry.entryDate}. The original entry
              is never changed or deleted. This cannot be undone.
            </>
          }
          confirmLabel="Reverse entry"
          tone="danger"
          busy={reversingId !== null}
          onConfirm={() => {
            const target = confirmEntry;
            setConfirmEntry(null);
            void handleReverse(target.id);
          }}
          onCancel={() => setConfirmEntry(null)}
        />
      )}
    </section>
  );
}
