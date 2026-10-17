import { useEffect, useState, type FormEvent } from 'react';
import { StickyNote } from 'lucide-react';
import { useCan } from '../../context/AuthContext';
import {
  addHistoryNote,
  listHistory,
  type HistoryEntry,
} from '../../services/fetchServices';
import LoadingState from '../ui/LoadingState';
import { primaryButtonClass } from '../ui/formClasses';

/**
 * Phase 46c — the Xero-style History & notes timeline under a document,
 * payment, contact or bank line. Collapsed by default, and it fetches only
 * when expanded, so a page that never opens it makes no extra request.
 *
 * `basePath` is the API resource path (`/invoices`, `/bills`, …). The
 * server writes every event on the document's own transaction; this panel
 * only reads them and posts user notes.
 */
export interface HistoryAndNotesProps {
  basePath: string;
  entityId: string;
  /** The permission that allows adding a note (checked with useCan). */
  notePermission: string;
  /** Changing this value re-fetches while the panel is open. */
  reloadKey?: unknown;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function HistoryAndNotes({
  basePath,
  entityId,
  notePermission,
  reloadKey,
}: HistoryAndNotesProps) {
  const can = useCan();
  const canNote = can(notePermission);

  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let ignore = false;

    listHistory(basePath, entityId)
      .then(({ history: entries }) => {
        if (!ignore) {
          setHistory(entries);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load history');
      });

    return () => {
      ignore = true;
    };
  }, [open, basePath, entityId, reloadKey]);

  async function handleAddNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = noteText.trim();
    if (text === '') return;
    setNoteError(null);
    setBusy(true);
    try {
      const { entry } = await addHistoryNote(basePath, entityId, text);
      setHistory((current) => [entry, ...(current ?? [])]);
      setNoteText('');
    } catch (err: unknown) {
      setNoteError(err instanceof Error ? err.message : 'Could not add that note');
    } finally {
      setBusy(false);
    }
  }

  const countLabel = history === null ? '' : ` (${String(history.length)})`;

  return (
    <section aria-label="History and notes" className="rounded-lg border border-[var(--border)] bg-[var(--panel)]">
      <h3 className="text-sm font-semibold m-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-transparent border-0 cursor-pointer text-left text-[var(--text)]"
        >
          <span>History &amp; notes{countLabel}</span>
          <span aria-hidden="true" className="text-[var(--muted)]">{open ? '▴' : '▾'}</span>
        </button>
      </h3>

      {open && (
        <div className="px-4 pb-4 flex flex-col gap-3">
          {canNote && (
            <form onSubmit={(event) => void handleAddNote(event)} className="flex flex-col gap-2">
              <label className="visually-hidden" htmlFor={`history-note-${entityId}`}>
                Note
              </label>
              <textarea
                id={`history-note-${entityId}`}
                value={noteText}
                maxLength={1000}
                rows={2}
                onChange={(event) => setNoteText(event.target.value)}
                className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full"
                placeholder="Add a note for your team"
              />
              <div className="flex items-center justify-end gap-2">
                {noteError !== null && <p role="alert" className="text-sm text-[var(--bad)] m-0 mr-auto">{noteError}</p>}
                <button
                  type="submit"
                  disabled={busy || noteText.trim() === ''}
                  className={primaryButtonClass}
                >
                  Add note
                </button>
              </div>
            </form>
          )}

          {error !== null && <p role="alert" className="text-sm text-[var(--bad)] m-0">{error}</p>}

          {error === null && history === null && <LoadingState rows={2} label="Loading history" />}

          {history !== null && history.length === 0 && (
            <p className="text-sm text-[var(--muted)] m-0">No history yet.</p>
          )}

          {history !== null && history.length > 0 && (
            <ul className="list-none m-0 p-0 flex flex-col">
              {history.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-col gap-0.5 py-2 border-t border-[var(--border)] first:border-t-0"
                >
                  <div className="flex items-center gap-2 flex-wrap text-xs text-[var(--muted)]">
                    {entry.kind === 'NOTE' && (
                      <>
                        <StickyNote size={12} aria-hidden="true" />
                        <span className="visually-hidden">Note</span>
                      </>
                    )}
                    <span>{entry.actorName ?? 'System'}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                  </div>
                  <p className="text-sm m-0 whitespace-pre-wrap">{entry.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
