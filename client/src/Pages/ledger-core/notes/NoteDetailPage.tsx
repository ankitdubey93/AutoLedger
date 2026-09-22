import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiRequestError } from '../../../services/fetchServices';
import { formatCents, formatQuantity, formatRate, parseCentsInput } from '../../../utils/money';
import { useAppBasePath } from '../../../apps/useAppBasePath';
import BackLink from '../../../components/BackLink';
import ConfirmDialog from '../../../components/ConfirmDialog';
import { noteStatusPill } from './NoteListPage';
import { REASON_LABELS, type NoteKindConfig, type NoteView, type OriginalView } from './noteKinds';

/**
 * One credit or debit note (Phase 26). A DRAFT can be edited, deleted or
 * issued; an ISSUED note can only be voided (guardrails rule 6) — and, while
 * it still has unapplied credit, applied to another open document of the
 * same party. Applying posts no journal entry: the note and the document
 * already sit in the same control account, so applying only matches them.
 */

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

function today(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function ApplyDialog({
  config,
  note,
  onClose,
  onApplied,
}: {
  config: NoteKindConfig;
  note: NoteView;
  onClose: () => void;
  onApplied: (updated: NoteView) => void;
}) {
  const [targets, setTargets] = useState<OriginalView[] | null>(null);
  const [targetId, setTargetId] = useState('');
  const [amount, setAmount] = useState('');
  const [allocationDate, setAllocationDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    config
      .listOpenTargets(note.partyId)
      .then((list) => {
        if (ignore) return;
        const eligible = list.filter((t) => t.currencyCode === note.currencyCode && t.amountDueCents > 0);
        setTargets(eligible);
        const first = eligible[0];
        if (first !== undefined) {
          setTargetId(first.id);
          setAmount(formatCents(Math.min(note.unappliedCents, first.amountDueCents)));
        }
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load open documents');
      });
    return () => {
      ignore = true;
    };
  }, [config, note]);

  function chooseTarget(id: string) {
    setTargetId(id);
    const target = targets?.find((t) => t.id === id);
    if (target !== undefined) setAmount(formatCents(Math.min(note.unappliedCents, target.amountDueCents)));
  }

  async function handleApply() {
    const amountCents = parseCentsInput(amount);
    if (amountCents === null || amountCents <= 0) {
      setError('Enter an amount above zero');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onApplied(await config.apply(note.id, { targetId, amountCents, allocationDate }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not apply the credit');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="apply-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3">
        <h3 id="apply-title" className="text-base font-semibold m-0">
          Apply credit — {formatCents(note.unappliedCents)} available
        </h3>
        <p className="text-sm text-[var(--muted)] m-0">
          Matches this note against another open {config.originalNoun} of {note.partyName}. No journal entry is posted.
        </p>
        {targets === null && error === null && <p className="muted">Loading…</p>}
        {targets !== null && targets.length === 0 && (
          <p className="muted">{note.partyName} has no open {config.originalNoun} in {note.currencyCode} to apply this to.</p>
        )}
        {targets !== null && targets.length > 0 && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Apply to</span>
              <select value={targetId} onChange={(e) => chooseTarget(e.target.value)} className={inputClass}>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {t.date} · due {formatCents(t.amountDueCents)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Amount</span>
              <input aria-label="Amount to apply" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Date</span>
              <input type="date" value={allocationDate} onChange={(e) => setAllocationDate(e.target.value)} className={inputClass} />
            </label>
          </>
        )}
        {error !== null && <p className="status status--bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={busy || targets === null || targets.length === 0}
            className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

export default function NoteDetailPage({ config }: { config: NoteKindConfig }) {
  const { noteId } = useParams<{ noteId: string }>();
  const base = useAppBasePath();
  const navigate = useNavigate();
  const [note, setNote] = useState<NoteView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'issue' | 'void' | 'delete' | null>(null);
  const [showApply, setShowApply] = useState(false);

  useEffect(() => {
    if (noteId === undefined) return;
    let ignore = false;
    setNote(null);
    config
      .get(noteId)
      .then((loaded) => {
        if (!ignore) setNote(loaded);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
        else setError(err instanceof Error ? err.message : `Could not load the ${config.title.toLowerCase()}`);
      });
    return () => {
      ignore = true;
    };
  }, [config, noteId]);

  async function run(action: 'issue' | 'void' | 'delete') {
    if (note === null) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'delete') {
        await config.remove(note.id);
        void navigate(`${base}/${config.originalPath}/${note.originalId}`);
        return;
      }
      setNote(action === 'issue' ? await config.issue(note.id) : await config.void(note.id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Could not ${action} the ${config.title.toLowerCase()}`);
    } finally {
      setBusy(false);
    }
  }

  const backLink = <BackLink to={`${base}/${config.path}`} label={`Back to ${config.plural.toLowerCase()}`} />;

  if (notFound) {
    return (
      <section className="flex flex-col gap-3">
        {backLink}
        <p className="status status--bad">{config.title} not found.</p>
      </section>
    );
  }
  if (note === null) {
    return error !== null ? <p className="status status--bad">{error}</p> : <p className="muted">Loading…</p>;
  }

  const buttonClass =
    'px-3 py-1.5 rounded-md text-sm text-[var(--muted)] hover:text-[var(--text)] bg-transparent border border-[var(--border)] cursor-pointer disabled:opacity-40';
  const primaryClass =
    'px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--text)] text-[var(--bg)] disabled:opacity-40';

  return (
    <section className="flex flex-col gap-6">
      {backLink}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">{note.number ?? `Draft ${config.title.toLowerCase()}`}</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1 flex items-center gap-2">
            {noteStatusPill(note.status)} {config.title} against{' '}
            <Link to={`${base}/${config.originalPath}/${note.originalId}`}>{note.originalLabel}</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {note.status === 'DRAFT' && (
            <>
              <Link to={`${base}/${config.path}/${note.id}/edit`} className={`${buttonClass} no-underline`}>
                Edit
              </Link>
              <button type="button" disabled={busy} onClick={() => setConfirmAction('delete')} className={buttonClass}>
                Delete
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmAction('issue')} className={primaryClass}>
                Issue
              </button>
            </>
          )}
          {note.status === 'ISSUED' && note.unappliedCents > 0 && (
            <button type="button" disabled={busy} onClick={() => setShowApply(true)} className={primaryClass}>
              Apply credit
            </button>
          )}
          {note.status !== 'VOID' && (
            <button type="button" disabled={busy} onClick={() => setConfirmAction('void')} className={buttonClass}>
              Void
            </button>
          )}
        </div>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-4">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 m-0 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{config.partyNoun}</dt>
            <dd className="m-0">{note.partyName}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Date</dt>
            <dd className="m-0 tabular-nums">{note.issueDate}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Reason</dt>
            <dd className="m-0">
              {REASON_LABELS[note.reasonCode]}
              {note.reason !== null && <span className="text-[var(--muted)]"> — {note.reason}</span>}
            </dd>
          </div>
          {note.vendorCreditReference !== null && (
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Vendor&apos;s credit note no.</dt>
              <dd className="m-0 font-mono">{note.vendorCreditReference}</dd>
            </div>
          )}
        </dl>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[36rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-2 font-medium">Description</th>
                <th className="p-2 font-medium text-right">Qty</th>
                <th className="p-2 font-medium text-right">Unit price</th>
                <th className="p-2 font-medium">Account</th>
                <th className="p-2 font-medium text-right">Tax</th>
                <th className="p-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {note.lines.map((line) => (
                <tr key={line.id} className="border-t border-[var(--border)]">
                  <td className="p-2">{line.description}</td>
                  <td className="p-2 text-right tabular-nums">{formatQuantity(line.quantityMilli)}</td>
                  <td className="p-2 text-right tabular-nums">{formatCents(line.unitPriceCents)}</td>
                  <td className="p-2">
                    {line.accountCode} {line.accountName}
                  </td>
                  <td className="p-2 text-right tabular-nums">{line.taxRateBp > 0 ? `${formatRate(line.taxRateBp)}%` : '—'}</td>
                  <td className="p-2 text-right tabular-nums">{formatCents(line.netCents + line.taxCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-1 self-end min-w-64 text-sm">
          <div className="flex justify-between gap-6">
            <span className="text-[var(--muted)]">Subtotal</span>
            <span className="tabular-nums">{formatCents(note.subtotalCents)}</span>
          </div>
          <div className="flex justify-between gap-6">
            <span className="text-[var(--muted)]">Tax</span>
            <span className="tabular-nums">{formatCents(note.taxCents)}</span>
          </div>
          <div className="flex justify-between gap-6 font-semibold border-t border-[var(--border)] pt-1">
            <span>Total</span>
            <span className="tabular-nums">
              {formatCents(note.totalCents)} {note.currencyCode}
            </span>
          </div>
          {note.status === 'ISSUED' && (
            <>
              <div className="flex justify-between gap-6">
                <span className="text-[var(--muted)]">Applied</span>
                <span className="tabular-nums">{formatCents(note.appliedCents)}</span>
              </div>
              <div className="flex justify-between gap-6 font-semibold">
                <span>Unapplied credit</span>
                <span className="tabular-nums" data-testid="unapplied">
                  {formatCents(note.unappliedCents)}
                </span>
              </div>
            </>
          )}
        </div>
        {note.notes !== null && <p className="text-sm text-[var(--muted)] m-0">{note.notes}</p>}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 m-0">
        {note.journalEntryId !== null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Journal entry</dt>
            <dd className="m-0">
              <Link to={`${base}/journals/${note.journalEntryId}`}>{note.journalEntryId.slice(0, 8)}</Link>
            </dd>
          </div>
        )}
        {note.voidJournalEntryId !== null && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">Void entry</dt>
            <dd className="m-0">
              <Link to={`${base}/journals/${note.voidJournalEntryId}`}>{note.voidJournalEntryId.slice(0, 8)}</Link>
            </dd>
          </div>
        )}
      </dl>

      {note.allocations.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold m-0">
            Applied to{note.status === 'VOID' ? ' (no longer counting — this note is void)' : ''}
          </h3>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[24rem]">
              <thead>
                <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                  <th className="p-2 font-medium">Document</th>
                  <th className="p-2 font-medium">Date</th>
                  <th className="p-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {note.allocations.map((a) => (
                  <tr key={a.id} className="border-t border-[var(--border)]">
                    <td className="p-2 font-mono text-xs">
                      <Link to={`${base}/${config.originalPath}/${a.documentId}`}>{a.documentLabel}</Link>
                    </td>
                    <td className="p-2 tabular-nums">{a.allocationDate}</td>
                    <td className="p-2 text-right tabular-nums">{formatCents(a.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirmAction === 'issue' && (
        <ConfirmDialog
          title={`Issue this ${config.title.toLowerCase()}?`}
          body={`${config.postingHint} An issued ${config.title.toLowerCase()} can never be edited — only voided.`}
          confirmLabel={`Issue ${config.title.toLowerCase()}`}
          busy={busy}
          onConfirm={() => {
            setConfirmAction(null);
            void run('issue');
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'void' && (
        <ConfirmDialog
          title={`Void this ${config.title.toLowerCase()}?`}
          body={`This posts a reversing journal entry, and every ${config.originalNoun} it was applied to owes that amount again. It cannot be undone.`}
          confirmLabel={`Void ${config.title.toLowerCase()}`}
          tone="danger"
          busy={busy}
          onConfirm={() => {
            setConfirmAction(null);
            void run('void');
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'delete' && (
        <ConfirmDialog
          title={`Delete this draft ${config.title.toLowerCase()}?`}
          body="A draft has posted nothing, so deleting it leaves no trace in the ledger."
          confirmLabel="Delete draft"
          tone="danger"
          busy={busy}
          onConfirm={() => {
            setConfirmAction(null);
            void run('delete');
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {showApply && (
        <ApplyDialog
          config={config}
          note={note}
          onClose={() => setShowApply(false)}
          onApplied={(updated) => {
            setShowApply(false);
            setNote(updated);
          }}
        />
      )}
    </section>
  );
}
