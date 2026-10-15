import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { uploadDocument, type VaultDocument } from '../services/fetchServices';
import DocumentPickerDialog from './DocumentPickerDialog';

/**
 * Phase 43b — attachments for a document that does not exist yet. Files go to
 * the vault at once (unlinked); the chips here only remember their ids, and
 * the new-bill/invoice page sends them as `attachmentDocumentIds` so the
 * server links them inside the document's own transaction.
 */

export interface PendingAttachmentsProps {
  value: VaultDocument[];
  onChange: (documents: VaultDocument[]) => void;
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.csv,application/pdf,image/png,image/jpeg,text/csv';

export default function PendingAttachments({ value, onChange }: PendingAttachmentsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      let next = value;
      for (const file of files) {
        const { document } = await uploadDocument(file);
        if (!next.some((d) => d.id === document.id)) next = [...next, document];
      }
      onChange(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not upload that file');
    } finally {
      setBusy(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
    }
  }

  function handlePicked(_ids: string[], documents: VaultDocument[]) {
    const fresh = documents.filter((d) => !value.some((v) => v.id === d.id));
    if (fresh.length > 0) onChange([...value, ...fresh]);
  }

  return (
    <section
      aria-label="Attachments"
      className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!busy) void handleFiles([...e.dataTransfer.files]);
      }}
    >
      <h3 className="text-sm font-semibold m-0">Attachments</h3>
      {error !== null && <p className="status status--bad">{error}</p>}

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2 list-none p-0 m-0">
          {value.map((document) => (
            <li
              key={document.id}
              className="flex items-center gap-1.5 text-sm border border-[var(--border)] rounded-full pl-3 pr-1.5 py-1"
            >
              <span>{document.originalFilename}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((d) => d.id !== document.id))}
                aria-label={`Remove ${document.originalFilename}`}
                className="bg-transparent border-0 cursor-pointer text-[var(--muted)] hover:text-[var(--bad)] p-0.5"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={busy}
          accept={ACCEPT}
          aria-label="Upload files"
          onChange={(e) => void handleFiles([...(e.target.files ?? [])])}
          className="text-sm"
        />
        <button type="button" onClick={() => setPickerOpen(true)} disabled={busy} className="btn btn--ghost">
          Choose from Documents
        </button>
        <span className="text-xs text-[var(--muted)]">or drop files here</span>
      </div>

      <DocumentPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePicked}
        excludeIds={value.map((d) => d.id)}
      />
    </section>
  );
}
