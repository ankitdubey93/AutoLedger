import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

const inputClass = 'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)]';
const PAGE_SIZE = 20;

/** Inventory's item list: search, filter, paginate, select items for a QR label sheet. */
export default function InventoryItemsPage() {
  const auth = useAuth();
  const role = auth.status === 'authenticated' ? auth.role : null;
  const canWrite = role === 'OWNER' || role === 'ADMIN' || role === 'ACCOUNTANT';
  const navigate = useNavigate();
  const base = INVENTORY_BASE;

  const [items, setItems] = useState<StockItem[]>([]);
  const [categories, setCategories] = useState<StockCategory[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
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
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetchStockItems(
      {
        q: q === '' ? undefined : q,
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
  }, [q, categoryId, itemType, tracking, lowStock, includeInactive, page]);

  function toggleSelected(id: string) {
    setSelectedIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  function handlePrintSelected() {
    navigate(`${base}/labels`, {
      state: { targets: selectedIds.map((id) => ({ kind: 'ITEM', id, copies: 1 })) },
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[var(--text)]">Items</h1>
        {canWrite ? (
          <Link
            to={`${base}/items/new`}
            className="rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors px-3 py-1.5 text-sm font-medium text-white no-underline"
          >
            New item
          </Link>
        ) : null}
      </div>

      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 items-end">
        <input
          aria-label="Search"
          placeholder="Search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className={inputClass}
        />
        <select
          aria-label="Category"
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
        <select
          aria-label="Item type"
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
              {t}
            </option>
          ))}
        </select>
        <select
          aria-label="Tracking"
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
              {t}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-[var(--text)]">
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
        <label className="flex items-center gap-1.5 text-sm text-[var(--text)]">
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
        {selectedIds.length > 0 ? (
          <button
            type="button"
            onClick={handlePrintSelected}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
          >
            Print labels for selected
          </button>
        ) : null}
      </div>

      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-[var(--muted)]">
            <th className="pr-2 py-1"></th>
            <th className="pr-3 py-1">Code</th>
            <th className="pr-3 py-1">Name</th>
            <th className="pr-3 py-1">Category</th>
            <th className="pr-3 py-1">Tracking</th>
            <th className="pr-3 py-1">On hand</th>
            <th className="pr-3 py-1">Value</th>
            <th className="pr-3 py-1">Active</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t border-[var(--border)]">
              <td className="pr-2 py-1">
                <input
                  type="checkbox"
                  aria-label={`Select ${item.code}`}
                  checked={selectedIds.includes(item.id)}
                  onChange={() => toggleSelected(item.id)}
                />
              </td>
              <td className="pr-3 py-1">
                <Link to={`${base}/items/${item.id}`} className="text-[var(--text)]">
                  {item.code}
                </Link>
              </td>
              <td className="pr-3 py-1 text-[var(--text)]">{item.name}</td>
              <td className="pr-3 py-1 text-[var(--muted)]">{item.categoryName}</td>
              <td className="pr-3 py-1 text-[var(--muted)]">{item.tracking}</td>
              <td className="pr-3 py-1 text-[var(--text)]">
                {formatQuantityMilli(item.onHandQuantityMilli)} {item.uomCode}
              </td>
              <td className="pr-3 py-1 text-[var(--text)]">{formatCents(item.onHandValueCents)}</td>
              <td className="pr-3 py-1 text-[var(--muted)]">{item.isActive ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center gap-3 text-sm text-[var(--muted)]">
        <button type="button" disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>
          Page {currentPage} of {totalPages} ({totalCount} items)
        </span>
        <button type="button" disabled={currentPage >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
