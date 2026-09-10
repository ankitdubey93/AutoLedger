import { useEffect, useRef, useState } from 'react';
import {
  deleteDocument,
  downloadDocument,
  listDocuments,
  uploadDocument,
  type DocumentFilters,
  type VaultDocument,
} from '../services/fetchServices';
import ConfirmDialog from './ledger-core/ConfirmDialog';

/**
 * The suite-level Document Vault — every file uploaded to the platform, not
 * scoped to any one app's record. A vault upload here attaches to nothing;
 * attaching happens from an app's own detail page via AttachmentsPanel.
 *
 * Filter options are hard-coded from server/src/types/documents.ts's
 * DOCUMENT_ENTITY_TYPES_BY_APP — the source of truth for which entity types
 * exist — since the vault has no endpoint that enumerates it.
 */

const APP_SLUGS = ['ledger-core'] as const;
const ENTITY_TYPES_BY_APP: Record<string, readonly string[]> = {
  'ledger-core': ['invoice', 'bill', 'journal_entry', 'payment', 'customer', 'vendor'],
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [documents, setDocuments] = useState<VaultDocument[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [appSlug, setAppSlug] = useState('');
  const [entityType, setEntityType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<VaultDocument | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let ignore = false;

    const filters: DocumentFilters = { page: currentPage };
    if (appSlug !== '') filters.appSlug = appSlug;
    if (entityType !== '') filters.entityType = entityType;

    listDocuments(filters)
      .then((res) => {
        if (ignore) return;
        setDocuments(res.documents);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load documents');
      });

    return () => {
      ignore = true;
    };
  }, [appSlug, entityType, currentPage, reloadToken]);

  async function handleUpload(file: File) {
    setError(null);
    setBusy(true);
    try {
      await uploadDocument(file);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not upload that file');
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

  async function handleDelete(document: VaultDocument) {
    setError(null);
    setBusy(true);
    try {
      await deleteDocument(document.id);
      setPendingDelete(null);
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete that document');
    } finally {
      setBusy(false);
    }
  }

  const entityTypeOptions = appSlug === '' ? [] : (ENTITY_TYPES_BY_APP[appSlug] ?? []);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">Document Vault</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Every file uploaded to AutoLedger, across every app.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">App</span>
          <select
            value={appSlug}
            onChange={(e) => {
              setAppSlug(e.target.value);
              setEntityType('');
              setCurrentPage(1);
            }}
            className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
          >
            <option value="">All apps</option>
            {APP_SLUGS.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Record type</span>
          <select
            value={entityType}
            disabled={appSlug === ''}
            onChange={(e) => {
              setEntityType(e.target.value);
              setCurrentPage(1);
            }}
            className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] disabled:opacity-40"
          >
            <option value="">All record types</option>
            {entityTypeOptions.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>

        <input
          ref={fileInputRef}
          type="file"
          disabled={busy}
          accept=".pdf,.png,.jpg,.jpeg,.csv,application/pdf,image/png,image/jpeg,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void handleUpload(file);
          }}
          className="text-sm"
        />
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}

      {documents === null && error === null && <p className="muted">Loading…</p>}

      {documents !== null && documents.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <p className="text-sm text-[var(--muted)] m-0">No documents yet.</p>
        </div>
      )}

      {documents !== null && documents.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[48rem]">
            <thead>
              <tr>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Filename</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Type</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Size</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Uploaded by</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Uploaded</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Attachments</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{doc.originalFilename}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{doc.mimeType}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{formatBytes(doc.byteSize)}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{doc.uploadedByName ?? 'Unknown'}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">
                    {new Date(doc.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{doc.linkCount}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => void handleDownload(doc)} className="btn btn--ghost">
                        Download
                      </button>
                      {doc.linkCount === 0 ? (
                        <button
                          type="button"
                          onClick={() => setPendingDelete(doc)}
                          className="btn btn--ghost"
                        >
                          Delete
                        </button>
                      ) : (
                        <span
                          className="text-xs text-[var(--muted)]"
                          title="Detach from all records before deleting"
                        >
                          Delete
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {documents !== null && documents.length > 0 && totalPages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage((p) => p - 1)}
            className="btn btn--ghost"
          >
            Previous
          </button>
          <span className="text-[var(--muted)]">
            Page {currentPage} of {totalPages} ({totalCount} total)
          </span>
          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => setCurrentPage((p) => p + 1)}
            className="btn btn--ghost"
          >
            Next
          </button>
        </div>
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete this document?"
          body={`"${pendingDelete.originalFilename}" will be permanently removed from the vault. This cannot be undone.`}
          confirmLabel="Delete"
          busy={busy}
          tone="danger"
          onConfirm={() => void handleDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
