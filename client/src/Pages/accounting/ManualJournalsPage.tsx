import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  listManualJournals,
  listRecurringSchedules,
  type ManualJournalOrigin,
  type ManualJournalStatus,
  type ManualJournalSummary,
  type RecurringSchedule,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import { useDebouncedInput } from '../../utils/useDebouncedInput';
import Pagination from '../../components/ui/Pagination';
import LoadingState from '../../components/ui/LoadingState';
import TabBar from '../../components/ui/TabBar';
import ImportButton from '../../components/imports/ImportButton';

/**
 * Phase 44 — the Manual journals list. Manual journals only: the all-postings
 * register is the General journal report (`/reports/general-journal`).
 *
 * Five tabs. Four filter the journals by status (`?status=`); the fifth,
 * Repeating, lists the JOURNAL recurring schedules instead. Filters live in the
 * URL, as JournalsPage does, so the list is linkable and survives a reload.
 */

type TabId = 'all' | 'draft' | 'posted' | 'voided' | 'repeating';
const TAB_IDS: readonly TabId[] = ['all', 'draft', 'posted', 'voided', 'repeating'];

function isTabId(value: string): value is TabId {
  return (TAB_IDS as readonly string[]).includes(value);
}

function statusPill(status: ManualJournalStatus) {
  if (status === 'DRAFT') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
        Draft
      </span>
    );
  }
  if (status === 'VOIDED') {
    return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)] line-through">Voided</span>;
  }
  return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Posted</span>;
}

function originLabel(origin: ManualJournalOrigin): string {
  if (origin === 'MANUAL') return 'Manual';
  if (origin === 'RECURRING') return 'Repeating';
  return 'Imported';
}

function frequencyLabel(frequency: string, intervalCount: number): string {
  const plural = intervalCount > 1 ? 's' : '';
  if (frequency === 'WEEKLY') return `Every ${intervalCount} week${plural}`;
  if (frequency === 'MONTHLY') return `Every ${intervalCount} month${plural}`;
  if (frequency === 'QUARTERLY') return `Every ${intervalCount} quarter${plural}`;
  return `Every ${intervalCount} year${plural}`;
}

export default function ManualJournalsPage() {
  const [params, setParams] = useSearchParams();
  const [journals, setJournals] = useState<ManualJournalSummary[]>([]);
  const [counts, setCounts] = useState<{ all: number; draft: number; posted: number; voided: number } | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [schedules, setSchedules] = useState<RecurringSchedule[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const statusParam = params.get('status') ?? 'all';
  const tab: TabId = isTabId(statusParam) ? statusParam : 'all';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? '1');
  const [qDraft, setQDraft] = useDebouncedInput(q, (v) => setFilter('q', v));

  useEffect(() => {
    if (tab === 'repeating') return;
    let ignore = false;
    setError(null);

    listManualJournals({
      status: tab,
      page,
      ...(q !== '' ? { q } : {}),
      ...(from !== '' ? { from } : {}),
      ...(to !== '' ? { to } : {}),
    })
      .then((res) => {
        if (ignore) return;
        setJournals(res.journals);
        setCounts(res.counts);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load manual journals');
      });

    return () => {
      ignore = true;
    };
  }, [tab, from, to, q, page]);

  useEffect(() => {
    if (tab !== 'repeating') return;
    let ignore = false;
    setError(null);

    listRecurringSchedules({ kind: 'JOURNAL', ...(activeOnly ? { status: 'ACTIVE' } : {}) })
      .then((res) => {
        if (!ignore) setSchedules(res.schedules);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load repeating journals');
      });

    return () => {
      ignore = true;
    };
  }, [tab, activeOnly]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    setParams(next);
  }

  function selectTab(id: string) {
    const next = new URLSearchParams(params);
    if (id === 'all') next.delete('status');
    else next.set('status', id);
    next.delete('page');
    setParams(next);
  }

  function goToPage(next: number) {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete('page');
    else nextParams.set('page', String(next));
    setParams(nextParams);
  }

  const tabItems = [
    { id: 'all', label: counts === null ? 'All' : `All (${String(counts.all)})` },
    { id: 'draft', label: counts === null ? 'Draft' : `Draft (${String(counts.draft)})` },
    { id: 'posted', label: counts === null ? 'Posted' : `Posted (${String(counts.posted)})` },
    { id: 'voided', label: counts === null ? 'Voided' : `Voided (${String(counts.voided)})` },
    { id: 'repeating', label: 'Repeating' },
  ];

  const inputClass =
    'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Manual journals</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Journals you enter by hand. A posted journal is never edited; void it to post a reversal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton kind="JOURNALS" returnTo="/manual-journals" />
          <Link
            to="/manual-journals/repeating/new"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline border border-[var(--border)] text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors"
          >
            New repeating journal
          </Link>
          <Link
            to="/manual-journals/new"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            New journal
          </Link>
        </div>
      </header>

      <TabBar
        variant="buttons"
        items={tabItems}
        active={tab}
        onChange={selectTab}
        ariaLabel="Filter manual journals by status"
      />

      {error !== null && <p className="status status--bad">{error}</p>}

      {tab === 'repeating' ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
            <span>Active only</span>
          </label>

          {schedules.length === 0 ? (
            <p className="muted">No repeating journals.</p>
          ) : (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
              <table className="w-full border-collapse text-sm min-w-[40rem]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                    <th className="p-3 font-medium">Name</th>
                    <th className="p-3 font-medium">Frequency</th>
                    <th className="p-3 font-medium">Next run</th>
                    <th className="p-3 font-medium">Status</th>
                    <th className="p-3 font-medium">Auto-reverse</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((schedule) => (
                    <tr key={schedule.id} className="border-t border-[var(--border)]">
                      <td className="p-3">
                        <Link to={`/recurring/${schedule.id}`} className="text-[var(--accent)] hover:underline">
                          {schedule.name}
                        </Link>
                      </td>
                      <td className="p-3">{frequencyLabel(schedule.frequency, schedule.intervalCount)}</td>
                      <td className="p-3 tabular-nums">{schedule.nextRunDate ?? '—'}</td>
                      <td className="p-3">{schedule.status}</td>
                      <td className="p-3">{schedule.autoReverse ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">From</span>
              <input type="date" value={from} onChange={(e) => setFilter('from', e.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">To</span>
              <input type="date" value={to} onChange={(e) => setFilter('to', e.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
              <span className="text-[var(--muted)]">Search narration</span>
              <input
                type="text"
                value={qDraft}
                onChange={(e) => setQDraft(e.target.value)}
                aria-label="Search narration"
                placeholder="Accrued rent"
                className={inputClass}
              />
            </label>
          </div>

          {!loaded && error === null && <LoadingState />}

          {loaded && (
            <>
              {totalCount === 0 ? (
                <p className="muted">No manual journals yet.</p>
              ) : (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
                  <table className="w-full border-collapse text-sm min-w-[44rem]">
                    <thead>
                      <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                        <th className="p-3 font-medium">Date</th>
                        <th className="p-3 font-medium">Narration</th>
                        <th className="p-3 font-medium">Status</th>
                        <th className="p-3 font-medium">Origin</th>
                        <th className="p-3 font-medium text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {journals.map((journal) => (
                        <tr key={journal.id} className="border-t border-[var(--border)]">
                          <td className="p-3 tabular-nums whitespace-nowrap">{formatDate(journal.entryDate)}</td>
                          <td className="p-3">
                            <Link to={`/manual-journals/${journal.id}`} className="text-[var(--accent)] hover:underline">
                              {journal.narration}
                            </Link>
                          </td>
                          <td className="p-3">{statusPill(journal.status)}</td>
                          <td className="p-3">{originLabel(journal.origin)}</td>
                          <td className="p-3 text-right tabular-nums">{formatCents(journal.totalDebitCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {totalCount > 0 && (
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  shownCount={journals.length}
                  totalCount={totalCount}
                  noun="journals"
                  onPageChange={goToPage}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
