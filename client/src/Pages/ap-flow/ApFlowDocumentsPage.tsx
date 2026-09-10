import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createApFlowDocument,
  listApFlowDocuments,
  listDocuments,
  type ApFlowDocument,
  type ApFlowDocumentStatus,
  type VaultDocument,
} from '../../services/fetchServices';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * AP-Flow's capture register (Phase 10). Deliberately thin — the review
 * queue with side-by-side confidence colouring and per-line account
 * override is Phase 11.
 */

const STATUS_OPTIONS: ApFlowDocumentStatus[] = ['PENDING', 'PROCESSING', 'EXTRACTED', 'FAILED'];
const SCANNABLE_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

function StatusPill({ status }: { status: ApFlowDocumentStatus }) {
  if (status === 'PENDING') {
    return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Pending</span>;
  }
  if (status === 'PROCESSING') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 ring-1 ring-inset ring-sky-500/20">
        Processing
      </span>
    );
  }
  if (status === 'EXTRACTED') {
    return (
      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
        Extracted
      </span>
    );
  }
  return (
    <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/20">
      Failed
    </span>
  );
}

export default function ApFlowDocumentsPage() {
  const base = useAppBasePath();

  const [documents, setDocuments] = useState<ApFlowDocument[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState<ApFlowDocumentStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [captureCandidates, setCaptureCandidates] = useState<VaultDocument[]>([]);
  const [captureSelection, setCaptureSelection] = useState('');
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let ignore = false;
    const filters = statusFilter === '' ? {} : { status: statusFilter };

    listApFlowDocuments({ ...filters, page: currentPage })
      .then((res) => {
        if (ignore) return;
        setDocuments(res.documents);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load AP-Flow documents');
      });

    return () => {
      ignore = true;
    };
  }, [statusFilter, currentPage, reloadToken]);

  useEffect(() => {
    let ignore = false;
    listDocuments({ limit: 100 })
      .then((res) => {
        if (!ignore) {
          setCaptureCandidates(res.documents.filter((d) => SCANNABLE_MIME_TYPES.has(d.mimeType)));
        }
      })
      .catch(() => {
        // Non-fatal: the capture control just shows nothing to pick from.
      });
    return () => {
      ignore = true;
    };
  }, [reloadToken]);

  async function handleCapture() {
    if (captureSelection === '') return;
    setError(null);
    setCapturing(true);
    try {
      await createApFlowDocument(captureSelection);
      setCaptureSelection('');
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not register that document');
    } finally {
      setCapturing(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">AP-Flow</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Capture a vendor bill or receipt and extract it into a structured draft. Nothing here
          posts to the ledger — review and posting are a later phase.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Status</span>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as ApFlowDocumentStatus | '');
              setCurrentPage(1);
            }}
            className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Capture a document</span>
          <div className="flex items-center gap-2">
            <select
              value={captureSelection}
              disabled={capturing}
              onChange={(e) => setCaptureSelection(e.target.value)}
              className="bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] min-w-[16rem]"
            >
              <option value="">Choose a vault document…</option>
              {captureCandidates.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.originalFilename}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={captureSelection === '' || capturing}
              onClick={() => void handleCapture()}
              className="btn"
            >
              Capture
            </button>
          </div>
        </label>
      </div>

      {captureCandidates.length === 0 && (
        <p className="text-sm text-[var(--muted)] m-0">
          No PDF, PNG or JPEG documents are in the{' '}
          <Link to="/documents" className="underline">
            Document Vault
          </Link>{' '}
          yet — upload one there first.
        </p>
      )}

      {error !== null && <p className="status status--bad">{error}</p>}

      {documents === null && error === null && <p className="muted">Loading…</p>}

      {documents !== null && documents.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <p className="text-sm text-[var(--muted)] m-0">
            No documents have been captured yet. Upload one to the{' '}
            <Link to="/documents" className="underline">
              Document Vault
            </Link>{' '}
            and capture it above.
          </p>
        </div>
      )}

      {documents !== null && documents.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[42rem]">
            <thead>
              <tr>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Filename</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Status</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Pages</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Captured</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{doc.originalFilename}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">
                    <StatusPill status={doc.status} />
                  </td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{doc.pageCount ?? '—'}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">
                    {new Date(doc.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">
                    <Link to={`${base}/${doc.id}`} className="btn btn--ghost">
                      View
                    </Link>
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
    </section>
  );
}
