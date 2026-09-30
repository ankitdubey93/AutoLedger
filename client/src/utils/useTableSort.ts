import { useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';
export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}
export type SortValue = string | number | boolean | null | undefined;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Nulls last in either direction; strings by locale ("Item 2" before "Item 10"); numbers and booleans by value. */
function compare(a: SortValue, b: SortValue): number {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b);
  return Number(a) - Number(b);
}

/**
 * Sorts a list that is already fully loaded in the browser. Only for lists
 * the server returns in full (customers, vendors, products, …): sorting one
 * page of a server-paginated list would silently sort the wrong rows — those
 * sort on the server instead.
 *
 * `accessors` maps each sortable column key to the value it sorts by, so a
 * money column sorts by integer cents, not by its formatted text. Clicking
 * the active column flips direction; clicking another starts ascending.
 * `Array.prototype.sort` is stable, so equal values keep the server's order.
 *
 * `inputs` lists anything else an accessor reads (a balances map that loads
 * after the rows, say), so the order is recomputed when that arrives.
 */
export function useTableSort<T, K extends string>(
  rows: readonly T[] | null,
  accessors: Record<K, (row: T) => SortValue>,
  initial: SortState<NoInfer<K>>,
  inputs: readonly unknown[] = [],
) {
  const [sort, setSort] = useState<SortState<K>>(initial);

  const sorted = useMemo(() => {
    if (rows === null) return null;
    const accessor = accessors[sort.key];
    const sign = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((x, y) => {
      const a = accessor(x);
      const b = accessor(y);
      // Missing values stay last whichever way the column is sorted.
      const aMissing = a === null || a === undefined || a === '';
      const bMissing = b === null || b === undefined || b === '';
      if (aMissing || bMissing) return compare(a, b);
      return sign * compare(a, b);
    });
    // `accessors` is a fresh object each render by design; what it reads is
    // declared through `inputs` instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, ...inputs]);

  function toggle(key: K) {
    setSort((current) => (current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' }));
  }

  return { sorted, sort, toggle };
}
