import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import {
  createCorpusDocument,
  deleteCorpusDocument,
  getCorpusDocument,
  listCorpusDocuments,
  uploadDocument,
  type TaxGuardCorpusDocument,
  type TaxGuardJurisdiction,
} from '../../services/fetchServices';
import { useAuth } from '../../context/AuthContext';
import { useAppBasePath } from '../../apps/useAppBasePath';
import ConfirmDialog from '../../components/ConfirmDialog';

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';

const JURISDICTIONS: TaxGuardJurisdiction[] = ['IN', 'US', 'UK', 'CA', 'AU', 'OTHER'];
const IN_FLIGHT_STATUSES = new Set<TaxGuardCorpusDocument['status']>(['PENDING', 'PARSING', 'EMBEDDING']);
const POLL_INTERVAL_MS = 3000;

/**
 * The tax-act corpus — a title, a jurisdiction, and an ingested status. A
 * PENDING, PARSING or EMBEDDING row polls its own status every 3 seconds
 * until it leaves those states, the exact pattern BoardDeckDecksPage uses
 * for a generating deck, and stops polling on unmount.
 *
 * "Add to corpus" is hidden (not disabled) below ACCOUNTANT. Delete is
 * hidden below ADMIN and gated by ConfirmDialog.
 */
export default function TaxGuardCorpusPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canCreate = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';
  const canDelete = role === 'OWNER' || role === 'ADMIN';
  const base = useAppBasePath();

  const [documents, setDocuments] = useState<TaxGuardCorpusDocument[]>([]);
  const [title, setTitle] = useState('');
  const [jurisdiction, setJurisdiction] = useState<TaxGuardJurisdiction>('IN');
  const [actYear, setActYear] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  function reload() {
    setError(null);
    listCorpusDocuments()
      .then((res) => setDocuments(res.corpusDocuments))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the corpus'));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timers = pollTimers.current;
    for (const doc of documents) {
      const inFlight = IN_FLIGHT_STATUSES.has(doc.status);
      if (!inFlight || timers.has(doc.id)) continue;

      const poll = () => {
        getCorpusDocument(doc.id)
          .then((res) => {
            setDocuments((prev) => prev.map((d) => (d.id === doc.id ? res.corpusDocument : d)));
            if (IN_FLIGHT_STATUSES.has(res.corpusDocument.status)) {
              const t = setTimeout(poll, POLL_INTERVAL_MS);
              timers.set(doc.id, t);
            } else {
              timers.delete(doc.id);
            }
          })
          .catch(() => {
            timers.delete(doc.id);
          });
      };
      const t = setTimeout(poll, POLL_INTERVAL_MS);
      timers.set(doc.id, t);
    }
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents.map((d) => d.id).join(',')]);

  async function handleCreate() {
    if (title.trim() === '' || file === null) return;
    setCreating(true);
    setError(null);
    try {
      const uploaded = await uploadDocument(file);
      await createCorpusDocument({
        documentId: uploaded.document.id,
        title: title.trim(),
        jurisdiction,
        actYear: actYear.trim() === '' ? null : Number(actYear),
      });
      setTitle('');
      setActYear('');
      setFile(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add to corpus');
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmDelete() {
    if (pendingDeleteId === null) return;
    setDeleting(true);
    try {
      await deleteCorpusDocument(pendingDeleteId);
      setPendingDeleteId(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete corpus document');
    } finally {
      setDeleting(false);
    }
  }

  const pendingDeleteDoc = documents.find((d) => d.id === pendingDeleteId) ?? null;

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold m-0">Tax act corpus</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Upload a tax act PDF. It is parsed into citation-labelled sections and embedded in the background.
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {canCreate && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted)]">Title</span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted)]">Jurisdiction</span>
            <select
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value as TaxGuardJurisdiction)}
              className={inputClass}
            >
              {JURISDICTIONS.map((j) => (
                <option key={j} value={j}>
                  {j}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted)]">Act year (optional)</span>
            <input type="number" value={actYear} onChange={(e) => setActYear(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted)]">PDF</span>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className={inputClass}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={creating || title.trim() === '' || file === null}
            onClick={handleCreate}
          >
            {creating ? 'Adding…' : 'Add to corpus'}
          </button>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
              <th className="p-3 font-medium">Title</th>
              <th className="p-3 font-medium">Jurisdiction</th>
              <th className="p-3 font-medium">Chunks</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-t border-[var(--border)]">
                <td className="p-3">
                  <Link to={`${base}/corpus/${doc.id}`} className="text-[var(--text)] underline">
                    {doc.title}
                  </Link>
                </td>
                <td className="p-3">{doc.jurisdiction}</td>
                <td className="p-3">{doc.chunkCount}</td>
                <td className="p-3">
                  {doc.status}
                  {doc.status === 'FAILED' && doc.errorMessage !== null && (
                    <span className="text-[var(--muted)]"> — {doc.errorMessage}</span>
                  )}
                </td>
                <td className="p-3">
                  {canDelete && (
                    <button
                      type="button"
                      aria-label={`Delete ${doc.title}`}
                      className="btn btn--ghost"
                      onClick={() => setPendingDeleteId(doc.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {documents.length === 0 && (
              <tr>
                <td className="p-3 text-sm text-[var(--muted)]" colSpan={5}>
                  No tax acts in the corpus yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pendingDeleteDoc !== null && (
        <ConfirmDialog
          title="Delete from corpus?"
          body={
            <>
              Deleting <strong>{pendingDeleteDoc.title}</strong> removes it and its chunks permanently. This cannot
              be undone.
            </>
          }
          confirmLabel="Delete"
          tone="danger"
          busy={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </section>
  );
}
