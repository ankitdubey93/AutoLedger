import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gauge, Inbox, ListChecks, SlidersHorizontal } from 'lucide-react';
import {
  createApFlowDocument,
  listApFlowDocuments,
  listDocuments,
  type ApFlowDocument,
  type ApFlowDocumentStatus,
  type VaultDocument,
} from '../../services/fetchServices';
import { INBOX_BASE } from '../../routes/paths';
import InboxUploadPanel from './InboxUploadPanel';
import PageHeader from '../../components/ui/PageHeader';
import EmptyState from '../../components/ui/EmptyState';

/**
 * AP-Flow's capture register (Phase 10; direct upload and auto-post status
 * added in Phase 19). The review queue with side-by-side confidence
 * colouring and per-line account override is Phase 11.
 */

const STATUS_OPTIONS: ApFlowDocumentStatus[] = ['PENDING', 'PROCESSING', 'EXTRACTED', 'FAILED', 'POSTED', 'DUPLICATE'];
const SCANNABLE_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const IN_FLIGHT_STATUSES = new Set<ApFlowDocumentStatus>(['PENDING', 'PROCESSING']);
const POLL_INTERVAL_MS = 5000;

const PILL_CLASS = 'text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full ring-1 ring-inset';

function StatusPill({ status }: { status: ApFlowDocumentStatus }) {
  if (status === 'PENDING') {
    return <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Pending</span>;
  }
  if (status === 'PROCESSING') {
    return (
      <span
        className={PILL_CLASS}
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)', boxShadow: 'inset 0 0 0 1px var(--accent-soft)' }}
      >
        Processing
      </span>
    );
  }
  if (status === 'EXTRACTED') {
    return (
      <span
        className={PILL_CLASS}
        style={{ background: 'var(--good-soft)', color: 'var(--good)', boxShadow: 'inset 0 0 0 1px var(--good-soft)' }}
      >
        Extracted
      </span>
    );
  }
  if (status === 'POSTED') {
    return (
      <span
        className={PILL_CLASS}
        style={{ background: 'var(--panel-2)', color: 'var(--text)', boxShadow: 'inset 0 0 0 1px var(--border)' }}
      >
        Posted
      </span>
    );
  }
  if (status === 'DUPLICATE') {
    return (
      <span
        className={PILL_CLASS}
        style={{ background: 'var(--warn-soft)', color: 'var(--warn)', boxShadow: 'inset 0 0 0 1px var(--warn-soft)' }}
      >
        Possible duplicate
      </span>
    );
  }
  return (
    <span
      className={PILL_CLASS}
      style={{ background: 'var(--bad-soft)', color: 'var(--bad)', boxShadow: 'inset 0 0 0 1px var(--bad-soft)' }}
    >
      Failed
    </span>
  );
}

export default function InboxPage() {
  const base = INBOX_BASE;

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
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the bill inbox');
      });

    return () => {
      ignore = true;
    };
  }, [statusFilter, currentPage, reloadToken]);

  // Auto-refresh while anything is still processing, so a capture posted
  // automatically (or one that finishes extraction) shows up without a
  // manual reload.
  useEffect(() => {
    if (documents === null || !documents.some((d) => IN_FLIGHT_STATUSES.has(d.status))) return;
    const timer = setInterval(() => setReloadToken((t) => t + 1), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [documents]);

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
      <PageHeader
        as="h2"
        icon={Inbox}
        title="Bill inbox"
        subtitle="Upload a vendor bill or receipt. It is read for you and becomes a draft expense to check and post."
        actions={
          <>
            <Link to="/settings/ai-usage" className="btn btn--ghost flex items-center gap-1.5">
              <Gauge size={14} aria-hidden="true" /> AI usage
            </Link>
            <Link to="/settings/inbox" className="btn btn--ghost flex items-center gap-1.5">
              <SlidersHorizontal size={14} aria-hidden="true" /> Settings
            </Link>
            <Link to={`${base}/review`} className="btn btn--ghost flex items-center gap-1.5">
              <ListChecks size={14} aria-hidden="true" /> Review queue
            </Link>
          </>
        }
      />

      <InboxUploadPanel onUploaded={() => setReloadToken((t) => t + 1)} />

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
          <span className="text-[var(--muted)]">Or capture from the Document Vault</span>
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

      {error !== null && <p className="status status--bad">{error}</p>}

      {documents === null && error === null && <p className="muted">Loading…</p>}

      {documents !== null && documents.length === 0 && (
        <EmptyState icon={Inbox} title="No documents yet — drop one above." />
      )}

      {documents !== null && documents.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[42rem]">
            <thead>
              <tr>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Filename</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Status</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Posting</th>
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
                  <td className="px-3 py-2 border-b border-[var(--border)] text-[var(--muted)]">
                    {doc.autoPosted ? 'Auto' : doc.status === 'POSTED' ? 'Manual' : '—'}
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
