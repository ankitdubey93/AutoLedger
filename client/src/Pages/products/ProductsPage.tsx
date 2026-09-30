import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  fetchStockProductBalances,
  listAccounts,
  listItems,
  updateItem,
  type Account,
  type Item,
  type ItemType,
  type StockProductBalance,
} from '../../services/fetchServices';
import { formatCents } from '../../utils/money';
import ProductFormDialog from './ProductFormDialog';
import ImportButton from '../../components/imports/ImportButton';
import TabBar from '../../components/ui/TabBar';
import { useDebouncedInput } from '../../utils/useDebouncedInput';
import { useTableSort } from '../../utils/useTableSort';
import { useClientPage } from '../../utils/useClientPage';
import SortableHeader from '../../components/ui/SortableHeader';
import Pagination from '../../components/ui/Pagination';
import LoadingState from '../../components/ui/LoadingState';

/**
 * Products & Services — the one master an invoice or bill line is picked from
 * (Phase 24, extended in Phase 32).
 *
 * Every product is created and edited here through one form
 * (ProductFormDialog): services, untracked goods, and — by ticking "Track
 * inventory" — stocked goods with their opening quantity and cost, the way
 * Xero and QuickBooks do it. A tracked product also has a stock item under
 * Inventory (lots, serials, locations, custom fields), linked from its row.
 *
 * `?new=1` opens the create form on mount, the same idiom CreateMenu and
 * CustomersPage use to jump straight into "add one" from anywhere in the app.
 */

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

const TYPE_LABEL: Record<ItemType, string> = {
  SERVICE: 'Service',
  NON_INVENTORY: 'Non-inventory',
  INVENTORY: 'Inventory',
  FIXED_ASSET: 'Fixed asset',
};

type TabId = 'ALL' | ItemType;
const TABS: { id: TabId; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'SERVICE', label: 'Services' },
  { id: 'NON_INVENTORY', label: 'Non-inventory' },
  { id: 'INVENTORY', label: 'Inventory' },
  { id: 'FIXED_ASSET', label: 'Fixed assets' },
];

function formatQuantity(milli: number, decimalPlaces: number): string {
  return (milli / 1000).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimalPlaces });
}

export default function ProductsPage() {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<Item[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(params.get('new') === '1');
  const [editing, setEditing] = useState<Item | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [balances, setBalances] = useState<Map<string, StockProductBalance>>(new Map());
  const [tab, setTab] = useState<TabId>('ALL');
  const q = params.get('q') ?? '';
  const [qDraft, setQDraft] = useDebouncedInput(q, setSearch);

  useEffect(() => {
    let ignore = false;

    const filters: { q?: string; includeInactive: boolean } = { includeInactive: true };
    if (q !== '') filters.q = q;

    Promise.all([listItems(filters), listAccounts()])
      .then(([itemsRes, accountsRes]) => {
        if (ignore) return;
        setItems(itemsRes.items);
        setAccounts(accountsRes.accounts);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Could not load items');
      });

    // On-hand quantities for stock-managed products. Best effort: the page is
    // fully usable without them (a failed call just leaves the column blank).
    fetchStockProductBalances()
      .then((res) => {
        if (!ignore) setBalances(new Map(res.balances.map((b) => [b.ledgerItemId, b])));
      })
      .catch(() => undefined);

    return () => {
      ignore = true;
    };
  }, [q, reloadToken]);

  async function toggleActive(item: Item) {
    try {
      await updateItem(item.id, { isActive: !item.isActive });
      setReloadToken((t) => t + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update the item');
    }
  }

  // `?edit=<productId>` — deep link from a stock item's "Edit prices, tax and accounts".
  const editParam = params.get('edit');
  useEffect(() => {
    if (editParam === null || items === null) return;
    const target = items.find((i) => i.id === editParam);
    if (target !== undefined) setEditing(target);
    const next = new URLSearchParams(params);
    next.delete('edit');
    setParams(next, { replace: true });
  }, [editParam, items, params, setParams]);

  const visible = useMemo(() => (items === null ? null : items.filter((item) => tab === 'ALL' || item.itemType === tab)), [items, tab]);
  const { sorted: sortedItems, sort, toggle: toggleSort } = useTableSort(
    visible,
    {
      code: (row: Item) => row.code,
      name: (row: Item) => row.name,
      type: (row: Item) => row.itemType,
      onHand: (row: Item) => balances.get(row.id)?.onHandQuantityMilli ?? null,
      salePrice: (row: Item) => row.salePriceCents,
      purchasePrice: (row: Item) => row.purchasePriceCents,
      status: (row: Item) => (row.isActive ? 0 : 1),
    },
    { key: 'code', direction: 'asc' },
    [balances],
  );
  const paged = useClientPage(sortedItems);

  function setSearch(value: string) {
    const next = new URLSearchParams(params);
    if (value === '') next.delete('q');
    else next.set('q', value);
    next.delete('new');
    setParams(next);
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold m-0">Products &amp; Services</h2>
          <p className="text-sm text-[var(--muted)] m-0 mt-1">
            Everything you buy or sell. Tick “Track inventory” on a product to keep count of stock and its cost.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton kind="ITEMS" returnTo="/products" />
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            <Plus size={15} aria-hidden="true" /> New product or service
          </button>
        </div>
      </header>

      <TabBar ariaLabel="Item type" variant="buttons" items={TABS} active={tab} onChange={(id) => setTab(id as TabId)} />

      <label className="flex flex-col gap-1 text-sm max-w-xs">
        <span className="text-[var(--muted)]">Search</span>
        <input type="text" value={qDraft} onChange={(e) => setQDraft(e.target.value)} className={inputClass} />
      </label>

      {error !== null && <p className="status status--bad">{error}</p>}

      {(showForm || editing !== null) && (
        <ProductFormDialog
          {...(editing === null
            ? { initialTrack: params.get('track') === '1' }
            : { item: editing, stockItemId: balances.get(editing.id)?.stockItemId ?? null })}
          accounts={accounts}
          onSaved={() => {
            setShowForm(false);
            setEditing(null);
            setReloadToken((t) => t + 1);
          }}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      {items === null && error === null && <LoadingState />}

      {items !== null && items.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-8 text-center flex flex-col items-center gap-3">
          <p className="text-sm text-[var(--muted)] m-0">No items yet.</p>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            Create the first item
          </button>
        </div>
      )}

      {visible !== null && visible.length === 0 && items !== null && items.length > 0 && (
        <p className="text-sm text-[var(--muted)]">No {tab === 'ALL' ? 'items' : TYPE_LABEL[tab].toLowerCase()} yet.</p>
      )}

      {visible !== null && visible.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[42rem]">
            <thead>
              <tr className="text-left text-[var(--muted)] text-xs uppercase tracking-wide">
                <SortableHeader label="Code" sortKey="code" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Type" sortKey="type" sort={sort} onSort={toggleSort} />
                <SortableHeader label="On hand" sortKey="onHand" sort={sort} onSort={toggleSort} align="right" />
                <SortableHeader label="Sale price" sortKey="salePrice" sort={sort} onSort={toggleSort} align="right" />
                <SortableHeader label="Purchase price" sortKey="purchasePrice" sort={sort} onSort={toggleSort} align="right" />
                <SortableHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(paged.pageRows ?? []).map((item) => (
                <tr key={item.id} className="border-t border-[var(--border)]">
                  <td className="p-3">{item.code}</td>
                  <td className="p-3">{item.name}</td>
                  <td className="p-3">{TYPE_LABEL[item.itemType]}</td>
                  <td className="p-3 text-right tabular-nums">
                    {balances.get(item.id) === undefined
                      ? '—'
                      : `${formatQuantity(balances.get(item.id)?.onHandQuantityMilli ?? 0, balances.get(item.id)?.uomDecimalPlaces ?? 0)} ${balances.get(item.id)?.uomCode ?? ''}`}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {item.salePriceCents === null ? '—' : formatCents(item.salePriceCents)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {item.purchasePriceCents === null ? '—' : formatCents(item.purchasePriceCents)}
                  </td>
                  <td className="p-3">
                    {item.isActive ? (
                      <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Active</span>
                    ) : (
                      <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <button type="button" onClick={() => setEditing(item)} className="btn btn--ghost">
                      Edit
                    </button>
                    {item.stockManaged ? (
                      <Link
                        to={`/inventory/items/${balances.get(item.id)?.stockItemId ?? ''}`}
                        className="btn btn--ghost"
                      >
                        Open stock item
                      </Link>
                    ) : (
                      <button type="button" onClick={() => void toggleActive(item)} className="btn btn--ghost">
                        {item.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paged.pageRows !== null && (
        <Pagination
          page={paged.page}
          totalPages={paged.totalPages}
          shownCount={paged.pageRows.length}
          totalCount={paged.totalCount}
          noun="products"
          onPageChange={paged.setPage}
        />
      )}
    </section>
  );
}
