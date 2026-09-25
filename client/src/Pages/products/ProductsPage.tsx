import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  createItem,
  fetchStockProductBalances,
  listAccounts,
  listItems,
  updateItem,
  type Account,
  type Item,
  type ItemType,
  type StockProductBalance,
} from '../../services/fetchServices';
import { formatCents, parseCentsInput } from '../../utils/money';
import TabBar from '../../components/ui/TabBar';

/**
 * Products & Services — the one master an invoice or bill line is picked from
 * (Phase 24, extended in Phase 32).
 *
 * Four item types. SERVICE and NON_INVENTORY (office supplies, anything bought
 * or sold that is not quantity-tracked) are created here. INVENTORY and
 * FIXED_ASSET items are created in StockLedger, which creates the linked
 * product automatically; here they show their on-hand quantity and an "Open in
 * StockLedger" link, and their name/status are read-only.
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

function ItemForm({
  revenueAccounts,
  expenseAccounts,
  onCreated,
  onCancel,
}: {
  revenueAccounts: Account[];
  expenseAccounts: Account[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [itemType, setItemType] = useState<'SERVICE' | 'NON_INVENTORY'>('SERVICE');
  const [description, setDescription] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [revenueAccountId, setRevenueAccountId] = useState('');
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createItem({
        code: code.trim(),
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        itemType,
        salePriceCents: salePrice.trim() === '' ? null : (parseCentsInput(salePrice) ?? null),
        purchasePriceCents: purchasePrice.trim() === '' ? null : (parseCentsInput(purchasePrice) ?? null),
        revenueAccountId: revenueAccountId === '' ? null : revenueAccountId,
        expenseAccountId: expenseAccountId === '' ? null : expenseAccountId,
        saleTaxRateBp: 0,
        purchaseTaxRateBp: 0,
      });
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the item');
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"
    >
      <h3 className="text-sm font-semibold m-0">New product or service</h3>
      <p className="text-xs text-[var(--muted)] m-0">
        For anything you bill for or buy without tracking stock. To track quantity, use{' '}
        <Link to="/inventory/items/new" className="underline">
          New stock item
        </Link>{' '}
        — it appears here automatically.
      </p>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm w-32">
          <span className="text-[var(--muted)]">Code</span>
          <input
            type="text"
            required
            maxLength={40}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Name</span>
          <input
            type="text"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm w-48">
          <span className="text-[var(--muted)]">Type</span>
          <select
            value={itemType}
            onChange={(e) => setItemType(e.target.value as 'SERVICE' | 'NON_INVENTORY')}
            className={inputClass}
          >
            <option value="SERVICE">Service</option>
            <option value="NON_INVENTORY">Non-inventory (not stocked)</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
          <span className="text-[var(--muted)]">Sale price</span>
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={salePrice}
            onChange={(e) => setSalePrice(e.target.value)}
            className={`${inputClass} text-right tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Revenue account</span>
          <select
            value={revenueAccountId}
            onChange={(e) => setRevenueAccountId(e.target.value)}
            className={inputClass}
          >
            <option value="">None</option>
            {revenueAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-40">
          <span className="text-[var(--muted)]">Purchase price</span>
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={purchasePrice}
            onChange={(e) => setPurchasePrice(e.target.value)}
            className={`${inputClass} text-right tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
          <span className="text-[var(--muted)]">Expense account</span>
          <select
            value={expenseAccountId}
            onChange={(e) => setExpenseAccountId(e.target.value)}
            className={inputClass}
          >
            <option value="">None</option>
            {expenseAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClass} />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || code.trim() === '' || name.trim() === ''}
          className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Creating…' : 'Create item'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn--ghost">
          Cancel
        </button>
      </div>

      {error !== null && <p className="status status--bad">{error}</p>}
    </form>
  );
}

export default function ProductsPage() {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<Item[] | null>(null);
  const [revenueAccounts, setRevenueAccounts] = useState<Account[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(params.get('new') === '1');
  const [reloadToken, setReloadToken] = useState(0);
  const [balances, setBalances] = useState<Map<string, StockProductBalance>>(new Map());
  const [tab, setTab] = useState<TabId>('ALL');
  const q = params.get('q') ?? '';

  useEffect(() => {
    let ignore = false;

    const filters: { q?: string; includeInactive: boolean } = { includeInactive: true };
    if (q !== '') filters.q = q;

    Promise.all([listItems(filters), listAccounts()])
      .then(([itemsRes, accountsRes]) => {
        if (ignore) return;
        setItems(itemsRes.items);
        setRevenueAccounts(accountsRes.accounts.filter((a) => a.isPostable && a.type === 'Revenue'));
        setExpenseAccounts(accountsRes.accounts.filter((a) => a.isPostable && a.type === 'Expense'));
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

  const visible = items === null ? null : items.filter((item) => tab === 'ALL' || item.itemType === tab);

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
            Everything an invoice or bill line can be picked from — services, non-inventory items, stock and assets.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((open) => !open)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
        >
          <Plus size={15} aria-hidden="true" /> New product or service
        </button>
      </header>

      <TabBar ariaLabel="Item type" variant="buttons" items={TABS} active={tab} onChange={(id) => setTab(id as TabId)} />

      <label className="flex flex-col gap-1 text-sm max-w-xs">
        <span className="text-[var(--muted)]">Search</span>
        <input type="text" value={q} onChange={(e) => setSearch(e.target.value)} className={inputClass} />
      </label>

      {error !== null && <p className="status status--bad">{error}</p>}

      {showForm && (
        <ItemForm
          revenueAccounts={revenueAccounts}
          expenseAccounts={expenseAccounts}
          onCreated={() => {
            setShowForm(false);
            setReloadToken((t) => t + 1);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {items === null && error === null && <p className="muted">Loading…</p>}

      {items !== null && items.length === 0 && !showForm && (
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
                <th className="p-3 font-medium">Code</th>
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Type</th>
                <th className="p-3 font-medium text-right">On hand</th>
                <th className="p-3 font-medium text-right">Sale price</th>
                <th className="p-3 font-medium text-right">Purchase price</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
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
                  <td className="p-3 text-right">
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
    </section>
  );
}
