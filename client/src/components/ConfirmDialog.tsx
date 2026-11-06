import { useEffect, useRef } from 'react';

/**
 * A hand-rolled confirmation dialog — no `window.confirm` (it blocks the main
 * thread and cannot be driven from Testing Library) and no dialog library
 * (guardrails rule 14: no dependency before the phase that needs it).
 *
 * Used ahead of every action that cannot be undone by editing: reversing a
 * journal entry, issuing an invoice, voiding an invoice.
 */

export interface ConfirmDialogProps {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="animate-pop-in w-full max-w-sm rounded-lg bg-[var(--panel)] p-7 flex flex-col gap-5 shadow-[var(--shadow-lg)]"
      >
        <h3 id="confirm-dialog-title" className="section-title m-0">
          {title}
        </h3>
        <div className="text-sm text-[var(--muted)]">{body}</div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btn btn--ghost"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={[
              'px-5 py-2 rounded-full text-sm font-semibold border-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
              tone === 'danger' ? 'bg-[var(--bad)] text-[var(--bad-fg)]' : 'bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors',
            ].join(' ')}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
