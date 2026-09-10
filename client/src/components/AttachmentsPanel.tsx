import { useEffect, useRef, useState } from 'react';
import {
  attachDocument,
  detachDocument,
  downloadDocument,
  getDocument,
  listDocuments,
  uploadDocument,
  type VaultDocument,
} from '../services/fetchServices';
import ConfirmDialog from '../Pages/ledger-core/ConfirmDialog';

/**
 * A reusable panel of the documents attached to one record — dropped onto
 * LedgerCore's invoice, bill and journal-entry detail pages, but itself
 * app-agnostic: it lives in components/, not Pages/ledger-core/, because the
 * Document Vault is platform infrastructure (Phase 9.5), and this panel is
 * the cross-app proof of that — any app's detail page can mount it.
 */

export interface AttachmentsPanelProps {
  appSlug: string;
  entityType: string;
  entityId: string;
  /** Hides the upload control and every detach button. */
  readOnly?: boolean;
}

/**
 * A document plus the id of the *link* that ties it to this entity.
 * GET /documents (list, filtered) returns document rows only — the link id
 * lives on GET /documents/:id's `links[]`, so each listed document is
 * resolved once to find the one link matching this panel's own
 * (appSlug, entityType, entityId).
 */
interface AttachedDocument {
  document: VaultDocument;
  linkId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AttachmentsPanel({
  appSlug,
  entityType,
  entityId,
  readOnly = false,
}: AttachmentsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [attachments, setAttachments] = useState<AttachedDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDetach, setPendingDetach] = useState<AttachedDocument | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let ignore = false;

    async function load() {
      const { documents } = await listDocuments({ appSlug, entityType, entityId });
      const resolved = await Promise.all(
        documents.map(async (document) => {
          const { document: detail } = await getDocument(document.id);
          const link = detail.links.find(
            (l) => l.appSlug === appSlug && l.entityType === entityType && l.entityId === entityId,
          );
          return link === undefined ? null : { document, linkId: link.id };
        }),
      );
      return resolved.filter((a): a is AttachedDocument => a !== null);
    }

    load()
      .then((resolved) => {
        if (!ignore) setAttachments(resolved);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load attachments');
      });

    return () => {
      ignore = true;
    };
  }, [appSlug, entityType, entityId, reloadToken]);

  async function handleAttach(file: File) {
    setError(null);
    setBusy(true);
    try {
      // Two calls, in that order: upload is idempotent, so a file already in
      // the vault attaches without a second copy.
      const { document } = await uploadDocument(file);
      await attachDocument(document.id, { appSlug, entityType, entityId });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not attach that file';
      setError(message.includes('already attached') ? 'Already attached to this record' : message);
    } finally {
      setBusy(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
    }
  }

  async function handleDownload(document: VaultDocument) {
    setError(null);
    try {
      const { blob, filename } = await downloadDocument(document.id);
      const url = URL.createObjectURL(blob);
      try {
        const anchor = window.document.createElement('a');
        anchor.href = url;
        anchor.download = filename !== 'download' ? filename : document.originalFilename;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not download that file');
    }
  }

  async function handleDetach(target: AttachedDocument) {
    setError(null);
    setBusy(true);
    try {
      await detachDocument(target.document.id, target.linkId);
      setPendingDetach(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not detach that file');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
      <h3 className="text-sm font-semibold m-0">Attachments</h3>

      {error !== null && <p className="status status--bad">{error}</p>}

      {attachments === null && error === null && <p className="muted">Loading…</p>}

      {attachments !== null && attachments.length === 0 && (
        <p className="text-sm text-[var(--muted)] m-0">No attachments yet.</p>
      )}

      {attachments !== null && attachments.length > 0 && (
        <ul className="flex flex-col gap-2 list-none p-0 m-0">
          {attachments.map((attachment) => (
            <li
              key={attachment.document.id}
              className="flex items-center justify-between gap-3 text-sm border border-[var(--border)] rounded-md px-3 py-2"
            >
              <div className="flex flex-col">
                <span className="font-medium">{attachment.document.originalFilename}</span>
                <span className="text-[var(--muted)] text-xs">
                  {attachment.document.mimeType} · {formatBytes(attachment.document.byteSize)} ·{' '}
                  {attachment.document.uploadedByName ?? 'Unknown'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleDownload(attachment.document)}
                  className="btn btn--ghost"
                >
                  Download
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => setPendingDetach(attachment)}
                    disabled={busy}
                    className="btn btn--ghost"
                  >
                    Detach
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            disabled={busy}
            accept=".pdf,.png,.jpg,.jpeg,.csv,application/pdf,image/png,image/jpeg,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) void handleAttach(file);
            }}
            className="text-sm"
          />
        </div>
      )}

      {pendingDetach !== null && (
        <ConfirmDialog
          title="Detach this file?"
          body={`"${pendingDetach.document.originalFilename}" will no longer be linked to this record. The file itself stays in the vault.`}
          confirmLabel="Detach"
          busy={busy}
          tone="danger"
          onConfirm={() => void handleDetach(pendingDetach)}
          onCancel={() => setPendingDetach(null)}
        />
      )}
    </section>
  );
}
