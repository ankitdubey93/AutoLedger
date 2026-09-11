import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listApFlowReviewQueue, type ApFlowReviewQueueEntry } from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import { useAppBasePath } from '../../apps/useAppBasePath';

/**
 * The human review queue (Phase 11) — documents awaiting a reviewer's
 * attention, ordered so it goes where it is worth most: an arithmetic
 * contradiction first, then a document with an unmapped line, then lowest
 * model confidence, then newest.
 */

function confidenceClass(value: number | null): string {
  if (value === null) return 'text-[var(--muted)]';
  if (value < 0.5) return 'text-red-400';
  if (value < 0.8) return 'text-amber-400';
  return 'text-[var(--text)]';
}

function ReviewFlags({ entry }: { entry: ApFlowReviewQueueEntry }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {!entry.arithmeticOk && (
        <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 ring-1 ring-inset ring-red-500/20">
          Totals don&apos;t reconcile
        </span>
      )}
      {entry.unmappedLineCount > 0 && (
        <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
          {entry.unmappedLineCount} unmapped
        </span>
      )}
    </div>
  );
}

export default function ApFlowReviewQueuePage() {
  const base = useAppBasePath();

  const [entries, setEntries] = useState<ApFlowReviewQueueEntry[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    listApFlowReviewQueue({ page: currentPage })
      .then((res) => {
        if (ignore) return;
        setEntries(res.entries);
        setTotalCount(res.totalCount);
        setTotalPages(res.totalPages);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the review queue');
      });

    return () => {
      ignore = true;
    };
  }, [currentPage]);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold m-0">Review queue</h2>
        <p className="text-sm text-[var(--muted)] m-0 mt-1">
          Extracted documents awaiting approval, the ones needing the most attention first.
        </p>
      </header>

      {error !== null && <p className="status status--bad">{error}</p>}

      {entries === null && error === null && <p className="muted">Loading…</p>}

      {entries !== null && entries.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center">
          <p className="text-sm text-[var(--muted)] m-0">Nothing is waiting for review.</p>
        </div>
      )}

      {entries !== null && entries.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[48rem]">
            <thead>
              <tr>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Vendor</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Invoice #</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Date</th>
                <th className="text-right px-3 py-2 border-b border-[var(--border)]">Total</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Lines</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Confidence</th>
                <th className="text-left px-3 py-2 border-b border-[var(--border)]">Review</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="px-3 py-2 border-b border-[var(--border)]">
                    <div className="flex flex-col gap-1">
                      <span>{entry.vendorName ?? '—'}</span>
                      <ReviewFlags entry={entry} />
                    </div>
                  </td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{entry.invoiceNumber ?? '—'}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{entry.invoiceDate ?? '—'}</td>
                  <td className="px-3 py-2 border-b border-[var(--border)] text-right">
                    {entry.totalCents === null ? '—' : formatCents(entry.totalCents)}
                  </td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">{entry.lineItemCount}</td>
                  <td className={`px-3 py-2 border-b border-[var(--border)] ${confidenceClass(entry.lowestConfidence)}`}>
                    {entry.lowestConfidence === null ? '—' : `${String(Math.round(entry.lowestConfidence * 100))}%`}
                  </td>
                  <td className="px-3 py-2 border-b border-[var(--border)]">
                    <Link to={`${base}/${entry.id}`} className="btn btn--ghost">
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {entries !== null && entries.length > 0 && totalPages > 1 && (
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
