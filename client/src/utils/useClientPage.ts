import { useEffect, useState } from 'react';

/**
 * Pages a list that is already fully loaded in the browser. Returns to page 1
 * whenever the list itself changes (a new search, a new sort order), so a
 * user is never left on page 4 of a list that now has one page.
 *
 * "Changes" means a new array identity, so `rows` must be stable between
 * renders — React state, or a `useMemo` result. An array rebuilt inline
 * (`items.filter(...)` in the component body) is new on every render and
 * would snap back to page 1 each time.
 */
export function useClientPage<T>(rows: readonly T[] | null, pageSize = 25) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [rows]);

  const totalCount = rows?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const current = Math.min(page, totalPages);
  const pageRows = rows === null ? null : rows.slice((current - 1) * pageSize, current * pageSize);

  return { pageRows, page: current, totalPages, totalCount, setPage };
}
