import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { NoteStatus } from '../../../services/fetchServices';
import { formatCents } from '../../../utils/money';
import { useAppBasePath } from '../../../apps/useAppBasePath';
import { REASON_LABELS, type NoteKindConfig, type NoteView } from './noteKinds';

/**
 * The credit-note or debit-note register (Phase 26). There is deliberately no
 * "New" button: a note always corrects a specific invoice or expense, so it
 * is raised from that document's page, never from a blank form.
 */

const PAGE_LIMIT = 50;

const TABS: { key: string; label: string; status: NoteStatus | '' }[] = [
  { key: 'all', label: 'All', status: '' },
  { key: 'draft', label: 'Draft', status: 'DRAFT' },
  { key: 'issued', label: 'Issued', status: 'ISSUED' },
  { key: 'void', label: 'Void', status: 'VOID' },
];

export function noteStatusPill(status: NoteStatus) {
  if (status === 'DRAFT') {
    return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Draft</span>;
  }
  if (status === 'ISSUED') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
        Issued
      </span>
    );
  }
  return (
    <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
      Void
    </span>
  );
}

export default function NoteListPage({ config }: { config: NoteKindConfig }) {
  const base = useAppBasePath();
  const [params, setParams] = useSearchParams();
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const status = (params.get('status') ?? '') as NoteStatus | '';
  const page = Number(params.get('page') ?? '1');

  useEffect(() => {
    let ignore = false;
    setError(null);
    config
      .list({ page, limit: PAGE_LIMIT, status })
      .then((res) => {
        if (ignore) return;
        setNotes(res.notes);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(err instanceof Error ? err.message : `Could not load ${config.plural.toLowerCase()}`);
        setNotes([]);
        setTotalCount(0);
        setLoaded(true);
      });
    return () => {
      ignore = true;
    };
  }, [config, status, page]);

  function selectTab(next: NoteStatus | '') {
    const nextParams = new URLSearchParams(params);
    if (next === '') nextParams.delete('status');
    else nextParams.set('status', next);
    nextParams.delete('page');
    setParams(nextParams);
  }

  function goToPage(next: number) {
    const nextParams = new URLSearchParams(params);
    if (next <= 1) nextParams.delete('page');
    else nextParams.set('page', String(next));
    setParams(nextParams);
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">{config.plural}</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">{config.listHint}</p>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-[var(--border)]" aria-label={`${config.title} status`}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => selectTab(tab.status)}
            aria-current={status === tab.status ? 'page' : undefined}
            className={[
              'px-3 py-2 text-sm border-0 border-b-2 bg-transparent cursor-pointer -mb-px',
              status === tab.status
                ? 'border-[var(--text)] text-[var(--text)] font-medium'
                : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {error !== null && <p className="status status--bad">{error}</p>}
      {!loaded && error === null && <p className="muted">Loading…</p>}

      {loaded && totalCount === 0 && (
        <p className="muted">No {config.plural.toLowerCase()} {status === '' ? 'yet' : 'with this status'}.</p>
      )}

      {loaded && totalCount > 0 && (
        <>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[48rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-3 font-medium">Number</th>
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">{config.partyNoun}</th>
                  <th className="p-3 font-medium">Against</th>
                  <th className="p-3 font-medium">Reason</th>
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium text-right">Total</th>
                  <th className="p-3 font-medium text-right">Unapplied</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((note) => (
                  <tr key={note.id} className="border-t border-[var(--border)]">
                    <td className="p-3 font-mono text-xs">
                      <Link to={`${base}/${config.path}/${note.id}`}>{note.number ?? 'Draft'}</Link>
                    </td>
                    <td className="p-3 tabular-nums whitespace-nowrap">{note.issueDate}</td>
                    <td className="p-3">{note.partyName}</td>
                    <td className="p-3 font-mono text-xs">
                      <Link to={`${base}/${config.originalPath}/${note.originalId}`}>{note.originalLabel}</Link>
                    </td>
                    <td className="p-3">{REASON_LABELS[note.reasonCode]}</td>
                    <td className="p-3">{noteStatusPill(note.status)}</td>
                    <td className="p-3 text-right tabular-nums">{formatCents(note.totalCents)}</td>
                    <td className="p-3 text-right tabular-nums">
                      {note.status === 'ISSUED' ? formatCents(note.unappliedCents) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
            <span>
              Showing {notes.length} of {totalCount}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
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
        </>
      )}
    </section>
  );
}
