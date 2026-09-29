/**
 * The Previous / Next footer under a paged list: a "Showing N of M" count on
 * the left, the two buttons on the right. The same markup thirteen list pages
 * each wrote by hand; new and restyled pages use this instead.
 */
export default function Pagination({
  page,
  totalPages,
  shownCount,
  totalCount,
  noun = 'items',
  onPageChange,
}: {
  page: number;
  totalPages: number;
  shownCount: number;
  totalCount: number;
  noun?: string;
  onPageChange: (page: number) => void;
}) {
  if (totalCount === 0) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
      <span>
        Showing {shownCount} of {totalCount} {noun}
        {totalPages > 1 && ` · page ${String(page)} of ${String(totalPages)}`}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </button>
        <button type="button" className="btn btn--ghost" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
        </button>
      </div>
    </nav>
  );
}
