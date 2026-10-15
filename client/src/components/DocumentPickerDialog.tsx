import { useEffect, useRef, useState } from 'react';
import { listDocuments, type VaultDocument } from '../services/fetchServices';
import { formatDate } from '../utils/date';
import { useDebouncedValue } from '../utils/useDebouncedValue';
import LoadingState from './ui/LoadingState';

/**
 * Phase 43b — choose files already in the Document Vault. Hand-rolled like
 * ConfirmDialog (no dialog library). By default only documents with no link
 * anywhere are listed, so the dialog answers "what have I uploaded and not yet
 * used"; unticking the box lists every document. `excludeIds` hides documents
 * the caller already holds (e.g. chips pending on an unsaved bill).
 */

export interface DocumentPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Ids per the plan contract; the documents ride along so a caller can render chips without a refetch. */
  onPick: (ids: string[], documents: VaultDocument[]) => void;
  excludeIds: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentPickerDialog({ open, onClose, onPick, excludeIds }: DocumentPickerDialogProps) {
  const [search, setSearch] = useState('');
  const [unattached, setUnattached] = useState(true);
  const [documents, setDocuments] = useState<VaultDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, VaultDocument>>(new Map());
  const searchRef = useRef<HTMLInputElement>(null);
  const q = useDebouncedValue(search.trim());

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setDocuments(null);
    setError(null);
    listDocuments({ limit: 50, unattached, ...(q === '' ? {} : { q }) }, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setDocuments(res.documents);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Could not load documents');
      });
    return () => {
      controller.abort();
    };
  }, [open, q, unattached]);

  if (!open) return null;

  const visible = (documents ?? []).filter((d) => !excludeIds.includes(d.id));

  function toggle(document: VaultDocument) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(document.id)) next.delete(document.id);
      else next.set(document.id, document);
      return next;
    });
  }

  function handleAttach() {
    const picked = [...selected.values()];
    onPick(picked.map((d) => d.id), picked);
    setSelected(new Map());
    onClose();
  }

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose from Documents"
        className="animate-pop-in w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3 shadow-[var(--shadow-lg)]"
      >
        <h3 className="text-base font-semibold m-0">Choose from Documents</h3>
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by file name"
          aria-label="Search documents"
          className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={unattached} onChange={(e) => setUnattached(e.target.checked)} />
          Not yet attached
        </label>

        {error !== null && <p className="status status--bad">{error}</p>}
        {documents === null && error === null && <LoadingState />}
        {documents !== null && visible.length === 0 && (
          <p className="text-sm text-[var(--muted)] m-0">No documents found.</p>
        )}
        {visible.length > 0 && (
          <ul className="flex flex-col gap-1 list-none p-0 m-0 max-h-72 overflow-y-auto">
            {visible.map((document) => (
              <li key={document.id}>
                <label className="flex items-center gap-3 text-sm border border-[var(--border)] rounded-md px-3 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(document.id)}
                    onChange={() => toggle(document)}
                    aria-label={document.originalFilename}
                  />
                  <span className="flex-1 min-w-0 truncate font-medium">{document.originalFilename}</span>
                  <span className="text-xs text-[var(--muted)] whitespace-nowrap">
                    {formatBytes(document.byteSize)} · {formatDate(document.createdAt.slice(0, 10))}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleAttach}
            disabled={selected.size === 0}
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            Attach
          </button>
        </div>
      </div>
    </div>
  );
}
