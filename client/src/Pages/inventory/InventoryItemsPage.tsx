import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Boxes, Plus, Tags } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { INVENTORY_BASE } from '../../routes/paths';
import { formatQuantityMilli } from '../../utils/quantity';
import { formatCents } from '../../utils/money';
import {
  STOCK_ITEM_TYPES,
  STOCK_TRACKING_MODES,
  fetchStockCategories,
  fetchStockItems,
  type StockCategory,
  type StockItem,
  type StockItemType,
  type StockTrackingMode,
} from '../../services/fetchServices';
import { humanizeEnum } from '../../utils/enumLabel';
import { useDebouncedValue } from '../../utils/useDebouncedValue';
import PageHeader from '../../components/ui/PageHeader';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { inputClass } from '../../components/ui/formClasses';

const PAGE_SIZE = 20;

/** Inventory's item list: search, filter, paginate, select items for a QR label sheet. */
export default function InventoryItemsPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';
  const navigate = useNavigate();
  const base = INVENTORY_BASE;

  const [items, setItems] = useState<StockItem[] | null>(null);
  const [categories, setCategories] = useState<StockCategory[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const debouncedQ = useDebouncedValue(q.trim());
  const [categoryId, setCategoryId] = useState('');
  const [itemType, setItemType] = useState<StockItemType | ''>('');
  const [tracking, setTracking] = useState<StockTrackingMode | ''>('');
  const [lowStock, setLowStock] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    fetchStockCategories()
      .then((res) => setCategories(res.categories))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load categories'));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetchStockItems(
      {
        q: debouncedQ === '' ? undefined : debouncedQ,
        categoryId: categoryId === '' ? undefined : categoryId,
        itemType: itemType === '' ? undefined : itemType,
        tracking: tracking === '' ? undefined : tracking,
        lowStock,
        includeInactive,
        page,
        limit: PAGE_SIZE,
      },
      controller.signal,
    )
      .then((res) => {
        setItems(res.items);
        setTotalCount(res.totalCount);
        setCurrentPage(res.currentPage);
        setTotalPages(res.totalPages);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Could not load items');
      });
    return () => controller.abort();
  }, [debouncedQ, categoryId, itemType, tracking, lowStock, includeInactive, page]);

  function toggleSelected(id: string) {
    setSelectedIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  function handlePrintSelected() {
    navigate(`${base}/labels`, {
      state: { targets: selectedIds.map((id) => ({ kind: 'ITEM', id, copies: 1 })) },
    });
  }

  const filtered = debouncedQ !== '' || categoryId !== '' || itemType !== '' || tracking !== '' || lowStock || includeInactive;

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        icon={Boxes}
        title="Stock on hand"
        subtitle="Every stock item with its quantity and value on hand. Receive stock on a bill, sell it on an invoice."
        actions={
          <>
            {selectedIds.length > 0 && (
              <button type="button" onClick={handlePrintSelected} className="btn btn--ghost !mt-0 inline-flex items-center gap-1.5">
                <Tags size={15} aria-hidden="true" /> Print {selectedIds.length} label{selectedIds.length === 1 ? '' : 's'}
              </button>
            )}
            {canWrite && (
              <Link
                to={`${base}/items/new`}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium no-underline bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
              >
                <Plus size={15} aria-hidden="true" /> New item
              </Link>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Search</span>
          <input
            placeholder="Code or name"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Category</span>
          <select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
            className={inputClass}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.path}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Item type</span>
          <select
            value={itemType}
            onChange={(e) => {
              setItemType(e.target.value as StockItemType | '');
              setPage(1);
            }}
            className={inputClass}
          >
            <option value="">All types</option>
            {STOCK_ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanizeEnum(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Tracking</span>
          <select
            value={tracking}
            onChange={(e) => {
              setTracking(e.target.value as StockTrackingMode | '');
              setPage(1);
            }}
            className={inputClass}
          >
            <option value="">All tracking</option>
            {STOCK_TRACKING_MODES.map((t) => (
              <option key={t} value={t}>
                {humanizeEnum(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm pb-2">
          <input
            type="checkbox"
            checked={lowStock}
            onChange={(e) => {
              setLowStock(e.target.checked);
              setPage(1);
            }}
          />
          Low stock only
        </label>
        <label className="flex items-center gap-1.5 text-sm pb-2">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => {
              setIncludeInactive(e.target.checked);
              setPage(1);
            }}
          />
          Show inactive
        </label>
      </div>

      {error !== null && (
        <p role="alert" className="status status--bad">
          {error}
        </p>
      )}

      {items === null && error === null && <SkeletonRows count={6} />}

      {items !== null && items.length === 0 && (
        <EmptyState
          icon={Boxes}
          title={filtered ? 'No items match these filters' : 'No stock items yet'}
          body={filtered ? undefined : 'Create an item, then receive stock against it on a bill.'}
          action={
            !filtered && canWrite ? (
              <Link to={`${base}/items/new`} className="text-sm">
                Create the first item
              </Link>
            ) : undefined
          }
        />
      )}

      {items !== null && items.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[48rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <th className="p-3 w-8">
                  <span className="visually-hidden">Select</span>
                </th>
                <th className="p-3 font-medium">Code</th>
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Category</th>
                <th className="p-3 font-medium">Tracking</th>
                <th className="p-3 font-medium text-right">On hand</th>
                <th className="p-3 font-medium text-right">Value</th>
                <th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-[var(--border)]">
                  <td className="p-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.code}`}
                      checked={selectedIds.includes(item.id)}
                      onChange={() => toggleSelected(item.id)}
                    />
                  </td>
                  <td className="p-3 font-mono text-xs">
                    <Link to={`${base}/items/${item.id}`}>{item.code}</Link>
                  </td>
                  <td className="p-3">{item.name}</td>
                  <td className="p-3 text-[var(--muted)]">{item.categoryName}</td>
                  <td className="p-3 text-[var(--muted)]">{humanizeEnum(item.tracking)}</td>
                  <td className="p-3 text-right tabular-nums">
                    {formatQuantityMilli(item.onHandQuantityMilli)} {item.uomCode}
                  </td>
                  <td className="p-3 text-right tabular-nums">{formatCents(item.onHandValueCents)}</td>
                  <td className="p-3 text-[var(--muted)]">{item.isActive ? 'Active' : 'Inactive'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {items !== null && (
        <Pagination
          page={currentPage}
          totalPages={totalPages}
          shownCount={items.length}
          totalCount={totalCount}
          onPageChange={setPage}
        />
      )}
    </section>
  );
}
