import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { SortState } from '../../utils/useTableSort';

/**
 * A column header that sorts its table. The button carries the click; the
 * `<th>` carries `aria-sort`, which is where assistive tech reads a column's
 * sort state (only the active column gets one — the others have none, per
 * the ARIA spec, rather than a misleading "none" on every column).
 */
export default function SortableHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className={`p-3 font-medium ${align === 'right' ? 'text-right' : ''}`}
      {...(active ? { 'aria-sort': sort.direction === 'asc' ? 'ascending' : 'descending' } : {})}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer uppercase tracking-wide text-xs font-medium ${
          active ? 'text-[var(--text)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
        } ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {label}
        <Icon size={12} aria-hidden="true" className={active ? '' : 'opacity-50'} />
      </button>
    </th>
  );
}
