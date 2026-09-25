import { useRef, useState } from 'react';
import { uploadApFlowDocument } from '../../services/fetchServices';

/**
 * AP-Flow's direct-upload panel (Phase 19) — drag-and-drop or a file picker,
 * straight into AP-Flow's own capture endpoint rather than the two-step
 * "vault it, then pick it from a dropdown" flow below. Files upload
 * sequentially, each reported as it finishes, so a batch of five doesn't
 * look like one opaque spinner.
 */

const ACCEPTED_TYPES = 'application/pdf,image/png,image/jpeg';

type FileOutcome = { name: string; state: 'uploading' | 'captured' | 'duplicate' | 'error'; message?: string };

export default function InboxUploadPanel({ onUploaded }: { onUploaded: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [outcomes, setOutcomes] = useState<FileOutcome[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    setOutcomes(list.map((f) => ({ name: f.name, state: 'uploading' })));

    for (const [index, file] of list.entries()) {
      try {
        const res = await uploadApFlowDocument(file);
        setOutcomes((prev) => {
          const next = [...prev];
          next[index] = { name: file.name, state: res.created ? 'captured' : 'duplicate' };
          return next;
        });
      } catch (err: unknown) {
        setOutcomes((prev) => {
          const next = [...prev];
          next[index] = {
            name: file.name,
            state: 'error',
            message: err instanceof Error ? err.message : 'Upload failed',
          };
          return next;
        });
      }
    }

    onUploaded();
  }

  return (
    <div
      className={`rounded-lg border border-dashed p-4 flex flex-col gap-3 transition-colors ${
        dragging
          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
          : 'border-[var(--border)] bg-[var(--panel)] hover:border-[var(--border-strong)]'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void uploadFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted)] m-0">
          Drop invoices, bills or receipts here (PDF, PNG, JPEG — up to 10 MB each)
        </p>
        <label className="btn btn--ghost cursor-pointer">
          Choose files
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPTED_TYPES}
            className="hidden"
            onChange={(e) => {
              if (e.target.files !== null) void uploadFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {outcomes.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm m-0 p-0 list-none">
          {outcomes.map((outcome, i) => (
            <li key={`${outcome.name}-${String(i)}`} className="flex items-center gap-2">
              <span className="text-[var(--text)]">{outcome.name}</span>
              {outcome.state === 'uploading' && <span className="text-[var(--muted)]">Uploading…</span>}
              {outcome.state === 'captured' && <span className="text-emerald-400">Captured</span>}
              {outcome.state === 'duplicate' && <span className="text-[var(--muted)]">Already captured</span>}
              {outcome.state === 'error' && <span className="status status--bad">{outcome.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
