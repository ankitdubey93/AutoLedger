import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiRequestError,
  deleteManualJournal,
  getManualJournal,
  postManualJournal,
  voidManualJournal,
  type ManualJournal,
  type ManualJournalOrigin,
  type ManualJournalStatus,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { formatDate } from '../../utils/date';
import BackLink from '../../components/BackLink';
import ConfirmDialog from '../../components/ConfirmDialog';
import MakeRecurringDialog from '../../components/MakeRecurringDialog';
import HistoryAndNotes from '../../components/history/HistoryAndNotes';
import { useCan } from '../../context/AuthContext';

/**
 * Phase 44 — one manual journal: its lines, its status, and the actions that
 * status allows. A DRAFT can be edited, posted or deleted. A POSTED journal can
 * be voided (a reversing entry is posted; the original stays) or copied. A
 * VOIDED journal links to both its entry and its reversal. A repeating TEMPLATE
 * links to its edit form and its schedule.
 *
 * Every action is gated on `journals.create` through `useCan()`. The server
 * re-checks each route, so the gate here is display only.
 */

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
  if (status === 'TEMPLATE') {
    return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Template</span>;
  }
  return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Posted</span>;
}

function originLabel(origin: ManualJournalOrigin): string {
  if (origin === 'MANUAL') return 'Manual';
  if (origin === 'RECURRING') return 'Repeating';
  return 'Imported';
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="m-0 text-sm">{children}</dd>
    </div>
  );
}

export default function ManualJournalDetailPage() {
  const { journalId } = useParams<{ journalId: string }>();
  const navigate = useNavigate();
  const can = useCan();

  const [journal, setJournal] = useState<ManualJournal | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingVoid, setConfirmingVoid] = useState(false);
  const [voidDate, setVoidDate] = useState('');
  const [showMakeRecurring, setShowMakeRecurring] = useState(false);

  function load(id: string, ignore: () => boolean) {
    return getManualJournal(id)
      .then((res) => {
        if (!ignore()) setJournal(res.journal);
      })
      .catch((err: unknown) => {
        if (ignore()) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setNotFound(true);
        } else {
          setLoadError(err instanceof Error ? err.message : 'Could not load the manual journal');
        }
      });
  }

  useEffect(() => {
    if (journalId === undefined) return;
    let ignore = false;
    setJournal(null);
    setNotFound(false);
    setLoadError(null);
    void load(journalId, () => ignore);

    return () => {
      ignore = true;
    };
    // load is recreated each render but only depends on journalId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalId]);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'That action failed');
    } finally {
      setBusy(false);
    }
  }

  async function handlePost() {
    if (journal === null) return;
    const id = journal.id;
    await runAction(async () => {
      await postManualJournal(id);
      await load(id, () => false);
    });
  }

  async function handleDelete() {
    if (journal === null) return;
    const id = journal.id;
    await runAction(async () => {
      await deleteManualJournal(id);
      navigate('/manual-journals');
    });
  }

  async function handleVoid() {
    if (journal === null) return;
    const id = journal.id;
    const date = voidDate === '' ? null : voidDate;
    await runAction(async () => {
      await voidManualJournal(id, { voidDate: date });
      await load(id, () => false);
    });
  }

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to="/manual-journals" label="Back to manual journals" />
        <p className="status status--bad">Manual journal not found.</p>
      </section>
    );
  }

  // A load that failed for any reason other than 404 would otherwise leave
  // the loading placeholder up forever.
  if (journal === null && loadError !== null) {
    return (
      <section className="flex flex-col gap-3">
        <BackLink to="/manual-journals" label="Back to manual journals" />
        <p className="status status--bad">{loadError}</p>
      </section>
    );
  }

  if (journal === null) {
    return (
      <div className="shell" aria-busy="true">
        <div className="skeleton skeleton--title" />
        <span className="visually-hidden">Loading manual journal…</span>
      </div>
    );
  }

  const canEdit = can('journals.create');
  const balanced = journal.totalDebitCents === journal.totalCreditCents;
  const journalEntryId = journal.journalEntryId;
  const voidJournalEntryId = journal.voidJournalEntryId;

  return (
    <section className="flex flex-col gap-6">
      <BackLink to="/manual-journals" label="Back to manual journals" />

      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{journal.narration}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1 flex items-center gap-2 flex-wrap">
            {statusPill(journal.status)}
            <span>{formatDate(journal.entryDate)}</span>
            <span>· {originLabel(journal.origin)}</span>
            <span>· Created by {journal.createdByName ?? '—'}</span>
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            {journal.status === 'DRAFT' && (
              <>
                <Link
                  to={`/manual-journals/${journal.id}/edit`}
                  className="px-3 py-1.5 rounded-md text-sm no-underline text-[var(--text)] bg-transparent border border-[var(--border)] hover:bg-[var(--panel-2)]"
                >
                  Edit
                </Link>
                <button
                  type="button"
                  onClick={() => void handlePost()}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-md text-sm font-medium cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] border-0 disabled:opacity-40"
                >
                  Post
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-md text-sm cursor-pointer text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] disabled:opacity-40"
                >
                  Delete
                </button>
              </>
            )}
            {journal.status === 'POSTED' && (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmingVoid(true)}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-md text-sm cursor-pointer text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] disabled:opacity-40"
                >
                  Void
                </button>
                <Link
                  to={`/manual-journals/new?copyFrom=${journal.id}`}
                  className="px-3 py-1.5 rounded-md text-sm no-underline text-[var(--text)] bg-transparent border border-[var(--border)] hover:bg-[var(--panel-2)]"
                >
                  Copy
                </Link>
                {journalEntryId !== null && (
                  <button
                    type="button"
                    onClick={() => setShowMakeRecurring(true)}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-md text-sm cursor-pointer text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] disabled:opacity-40"
                  >
                    Make recurring
                  </button>
                )}
              </>
            )}
            {journal.status === 'VOIDED' && (
              <Link
                to={`/manual-journals/new?copyFrom=${journal.id}`}
                className="px-3 py-1.5 rounded-md text-sm no-underline text-[var(--text)] bg-transparent border border-[var(--border)] hover:bg-[var(--panel-2)]"
              >
                Copy
              </Link>
            )}
            {journal.status === 'TEMPLATE' && (
              <Link
                to={`/manual-journals/${journal.id}/edit`}
                className="px-3 py-1.5 rounded-md text-sm no-underline text-[var(--text)] bg-transparent border border-[var(--border)] hover:bg-[var(--panel-2)]"
              >
                Edit template
              </Link>
            )}
          </div>
        )}
      </header>

      {actionError !== null && <p className="status status--bad">{actionError}</p>}

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 m-0">
        <DetailRow label="Date">{formatDate(journal.entryDate)}</DetailRow>
        <DetailRow label="Origin">{originLabel(journal.origin)}</DetailRow>
        <DetailRow label="Created by">{journal.createdByName ?? '—'}</DetailRow>
        {journal.status === 'POSTED' && journalEntryId !== null && (
          <DetailRow label="Ledger entry">
            <Link to={`/journals/${journalEntryId}`} className="text-[var(--accent)] hover:underline">
              View ledger entry
            </Link>
          </DetailRow>
        )}
        {journal.status === 'VOIDED' && journalEntryId !== null && (
          <DetailRow label="Ledger entry">
            <Link to={`/journals/${journalEntryId}`} className="text-[var(--accent)] hover:underline">
              View ledger entry
            </Link>
          </DetailRow>
        )}
        {journal.status === 'VOIDED' && voidJournalEntryId !== null && (
          <DetailRow label="Reversal">
            <Link to={`/journals/${voidJournalEntryId}`} className="text-[var(--accent)] hover:underline">
              View reversal
            </Link>
          </DetailRow>
        )}
        {journal.status === 'TEMPLATE' && journal.templateScheduleId !== null && (
          <DetailRow label="Schedule">
            <Link to={`/recurring/${journal.templateScheduleId}`} className="text-[var(--accent)] hover:underline">
              View schedule
            </Link>
          </DetailRow>
        )}
      </dl>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm min-w-[40rem]">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Description</th>
              <th className="p-3 font-medium">Account</th>
              <th className="p-3 font-medium text-right">Debit</th>
              <th className="p-3 font-medium text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {journal.lines.map((line) => (
              <tr key={line.id} className="border-t border-[var(--border)]">
                <td className="p-3">{line.description ?? '—'}</td>
                <td className="p-3 font-mono text-xs">
                  {line.accountCode !== null ? `${line.accountCode} · ${line.accountName ?? ''}` : '—'}
                </td>
                <td className="p-3 text-right tabular-nums">{line.debitCents > 0 ? formatCents(line.debitCents) : ''}</td>
                <td className="p-3 text-right tabular-nums">{line.creditCents > 0 ? formatCents(line.creditCents) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-[var(--border)] font-medium">
              <td className="p-3" colSpan={2}>
                {balanced ? 'Balanced' : 'Out of balance'}
              </td>
              <td className="p-3 text-right tabular-nums">{formatCents(journal.totalDebitCents)}</td>
              <td className="p-3 text-right tabular-nums">{formatCents(journal.totalCreditCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this draft?"
          body={<>The draft and its lines are removed. Nothing has been posted, so nothing in the ledger changes.</>}
          confirmLabel="Delete draft"
          tone="danger"
          busy={busy}
          onConfirm={() => {
            setConfirmingDelete(false);
            void handleDelete();
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {confirmingVoid && (
        <ConfirmDialog
          title="Void this journal?"
          body={
            <>
              <p className="m-0 mb-3">A reversing entry is posted. The original stays in the ledger.</p>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Void date (blank = the original date)</span>
                <input
                  type="date"
                  value={voidDate}
                  onChange={(e) => setVoidDate(e.target.value)}
                  aria-label="Void date"
                  className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
                />
              </label>
            </>
          }
          confirmLabel="Void journal"
          tone="danger"
          busy={busy}
          onConfirm={() => {
            setConfirmingVoid(false);
            void handleVoid();
          }}
          onCancel={() => setConfirmingVoid(false)}
        />
      )}

      <HistoryAndNotes basePath="/manual-journals" entityId={journal.id} notePermission="journals.create" />

      {showMakeRecurring && journalEntryId !== null && (
        <MakeRecurringDialog
          kind="JOURNAL"
          sourceId={journalEntryId}
          defaultName={journal.narration}
          onClose={() => setShowMakeRecurring(false)}
          onCreated={(scheduleId) => {
            setShowMakeRecurring(false);
            navigate(`/recurring/${scheduleId}`);
          }}
        />
      )}
    </section>
  );
}
