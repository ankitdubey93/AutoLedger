import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  createItem,
  createStockItem,
  createStockItemFromProduct,
  getItem,
  updateItem,
  updateStockItem,
  type Account,
  type Item,
} from '../../services/fetchServices';
import { formatCents, formatRate, parseCentsInput, parseQuantityInput, parseRateInput } from '../../utils/money';
import { inputClass, primaryButtonClass } from '../../components/ui/formClasses';
import { createWithCodeRetry, deriveItemCode } from './productCode';

/**
 * The one product form (Xero / QuickBooks style): name, what you pay, what
 * you charge, and a "Track inventory" box. Ticking it is all a trading
 * business needs to do — opening quantity and cost go on the same form, and
 * the server sets Inventory up silently the first time.
 *
 * Where each save goes:
 *   - new, not tracked      → POST /items (SERVICE or NON_INVENTORY)
 *   - new, tracked          → POST /inventory/items (creates the product + opening stock in one transaction)
 *   - edit                  → PATCH /items/:id (+ PATCH /inventory/items/:id for a tracked product's name)
 *   - edit, tracking ticked → PATCH, then POST /inventory/items/from-product/:id (forward-only)
 *
 * Tracked products need no category or code scheme here: the server falls
 * back to the org's default category and uses the code typed (or derived).
 * The full stock form (lots, serials, attributes) stays under Inventory.
 */

function todayIsoDate(): string {
  // UTC, like the server's "not in the future" check.
  return new Date().toISOString().slice(0, 10);
}

function centsOrNull(raw: string): number | null | 'invalid' {
  if (raw.trim() === '') return null;
  return parseCentsInput(raw) ?? 'invalid';
}

function rateBp(raw: string): number | 'invalid' {
  if (raw.trim() === '') return 0;
  const bp = parseRateInput(raw);
  return bp === null || bp < 0 || bp > 10_000 ? 'invalid' : bp;
}

function AccountSelect({
  label,
  value,
  onChange,
  accounts,
  emptyLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  accounts: Account[];
  emptyLabel: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm flex-1 min-w-44">
      <span className="text-[var(--muted)]">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{emptyLabel}</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.code} · {account.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function MoneyInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm w-36">
      <span className="text-[var(--muted)]">{label}</span>
      <input
        inputMode="decimal"
        placeholder={placeholder ?? formatCents(0)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} text-right tabular-nums`}
      />
    </label>
  );
}

function RateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm w-24">
      <span className="text-[var(--muted)]">{label}</span>
      <input
        inputMode="decimal"
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} text-right tabular-nums`}
      />
    </label>
  );
}

export interface ProductFormDialogProps {
  /** The product being edited; omitted = create. */
  item?: Item;
  /** For a tracked product being edited: its stock item, which owns the name. */
  stockItemId?: string | null;
  accounts: Account[];
  /** Quick-add from a document line: which side the person is on (focuses the form, nothing more). */
  context?: 'sale' | 'purchase';
  /** Start a new product with "Track inventory" ticked. */
  initialTrack?: boolean;
  /** Prefill the name (e.g. from what was typed in a picker). */
  initialName?: string;
  /** Quick-add: the line's account, prefilled as the revenue (sale) or expense (purchase) account. */
  initialAccountId?: string;
  onSaved: (item: Item) => void;
  onCancel: () => void;
}

export default function ProductFormDialog({
  item,
  stockItemId = null,
  accounts,
  context,
  initialTrack = false,
  initialName = '',
  initialAccountId = '',
  onSaved,
  onCancel,
}: ProductFormDialogProps) {
  const editing = item !== undefined;
  const alreadyTracked = item?.itemType === 'INVENTORY';

  const [name, setName] = useState(item?.name ?? initialName);
  const [code, setCode] = useState(item?.code ?? '');
  const [codeTouched, setCodeTouched] = useState(editing);
  const [isService, setIsService] = useState(item === undefined ? false : item.itemType === 'SERVICE');
  const [track, setTrack] = useState(alreadyTracked || (item === undefined && initialTrack));
  const [description, setDescription] = useState(item?.description ?? '');

  const [purchasePrice, setPurchasePrice] = useState(item?.purchasePriceCents == null ? '' : formatCents(item.purchasePriceCents));
  const [purchaseTax, setPurchaseTax] = useState(item === undefined || item.purchaseTaxRateBp === 0 ? '' : formatRate(item.purchaseTaxRateBp));
  const [expenseAccountId, setExpenseAccountId] = useState(
    item?.expenseAccountId ?? (context === 'purchase' && accounts.some((a) => a.id === initialAccountId && a.type === 'Expense') ? initialAccountId : ''),
  );
  const [salePrice, setSalePrice] = useState(item?.salePriceCents == null ? '' : formatCents(item.salePriceCents));
  const [saleTax, setSaleTax] = useState(item === undefined || item.saleTaxRateBp === 0 ? '' : formatRate(item.saleTaxRateBp));
  const [revenueAccountId, setRevenueAccountId] = useState(
    item?.revenueAccountId ?? (context === 'sale' && accounts.some((a) => a.id === initialAccountId && a.type === 'Revenue') ? initialAccountId : ''),
  );
  const [assetAccountId, setAssetAccountId] = useState(item?.assetAccountId ?? '');
  const [cogsAccountId, setCogsAccountId] = useState(item?.cogsAccountId ?? '');

  const [openingQty, setOpeningQty] = useState('');
  const [openingCost, setOpeningCost] = useState('');
  const [openingDate, setOpeningDate] = useState(todayIsoDate());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revenueAccounts = accounts.filter((a) => a.isPostable && a.type === 'Revenue');
  const expenseAccounts = accounts.filter((a) => a.isPostable && a.type === 'Expense');
  const assetAccounts = accounts.filter((a) => a.isPostable && a.type === 'Asset');

  const effectiveCode = codeTouched ? code : deriveItemCode(name);
  // A service is never stock; a tracked product stays tracked; a service stays a service.
  const canToggleTrack = !isService && !alreadyTracked;
  const converting = editing && !alreadyTracked && track;
  const showOpening = track && !alreadyTracked;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // Rendered from inside invoice/bill forms: keep the submit from bubbling to them.
    event.stopPropagation();

    const purchaseCents = centsOrNull(purchasePrice);
    const saleCents = centsOrNull(salePrice);
    const purchaseRate = rateBp(purchaseTax);
    const saleRate = rateBp(saleTax);
    if (purchaseCents === 'invalid' || saleCents === 'invalid') {
      setError('Prices must be amounts like 12.50');
      return;
    }
    if (purchaseRate === 'invalid' || saleRate === 'invalid') {
      setError('Tax rates must be a percentage between 0 and 100');
      return;
    }

    let opening: { quantityMilli: number; unitCostCents: number | null; occurredOn: string } | undefined;
    if (showOpening && openingQty.trim() !== '') {
      const quantityMilli = parseQuantityInput(openingQty);
      const costCents = centsOrNull(openingCost);
      if (quantityMilli === null || quantityMilli <= 0) {
        setError('Opening quantity must be a number above zero');
        return;
      }
      if (costCents === 'invalid') {
        setError('Unit cost must be an amount like 12.50');
        return;
      }
      if (costCents === null && purchaseCents === null) {
        setError('Enter a unit cost for the opening stock, or a purchase price');
        return;
      }
      opening = { quantityMilli, unitCostCents: costCents, occurredOn: openingDate };
    }

    setBusy(true);
    setError(null);
    try {
      const saved = await save({
        purchaseCents,
        saleCents,
        purchaseRate,
        saleRate,
        opening,
      });
      onSaved(saved);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the product');
      setBusy(false);
    }
  }

  async function save(values: {
    purchaseCents: number | null;
    saleCents: number | null;
    purchaseRate: number;
    saleRate: number;
    opening: { quantityMilli: number; unitCostCents: number | null; occurredOn: string } | undefined;
  }): Promise<Item> {
    const trimmedName = name.trim();
    const desc = description.trim() === '' ? null : description.trim();
    const orNull = (id: string) => (id === '' ? null : id);

    if (!editing) {
      if (track) {
        const stock = await createWithCodeRetry(effectiveCode.trim(), !codeTouched, (candidate) =>
          createStockItem({
            name: trimmedName,
            code: candidate,
            product: {
              salePriceCents: values.saleCents,
              purchasePriceCents: values.purchaseCents,
              revenueAccountId: orNull(revenueAccountId),
              assetAccountId: orNull(assetAccountId),
              cogsAccountId: orNull(cogsAccountId),
              saleTaxRateBp: values.saleRate,
              purchaseTaxRateBp: values.purchaseRate,
            },
            ...(values.opening === undefined ? {} : { opening: values.opening }),
          }),
        );
        if (stock.item.ledgerItemId === null) throw new Error('The stock item was created without a product');
        let product = (await getItem(stock.item.ledgerItemId)).item;
        // The stock form has no description field of its own for the product.
        if (desc !== null) product = (await updateItem(product.id, { description: desc })).item;
        return product;
      }
      const created = await createWithCodeRetry(effectiveCode.trim(), !codeTouched, (candidate) =>
        createItem({
          code: candidate,
          name: trimmedName,
          description: desc,
          itemType: isService ? 'SERVICE' : 'NON_INVENTORY',
          salePriceCents: values.saleCents,
          purchasePriceCents: values.purchaseCents,
          revenueAccountId: orNull(revenueAccountId),
          expenseAccountId: orNull(expenseAccountId),
          saleTaxRateBp: values.saleRate,
          purchaseTaxRateBp: values.purchaseRate,
        }),
      );
      return created.item;
    }

    // Editing. A tracked product's name belongs to its stock item (which pushes it here).
    if (alreadyTracked && trimmedName !== item.name && stockItemId !== null) {
      await updateStockItem(stockItemId, { name: trimmedName });
    }
    let updated = (
      await updateItem(item.id, {
        ...(alreadyTracked ? {} : { name: trimmedName }),
        description: desc,
        salePriceCents: values.saleCents,
        purchasePriceCents: values.purchaseCents,
        revenueAccountId: orNull(revenueAccountId),
        saleTaxRateBp: values.saleRate,
        purchaseTaxRateBp: values.purchaseRate,
        ...(alreadyTracked
          ? { assetAccountId: orNull(assetAccountId), cogsAccountId: orNull(cogsAccountId) }
          : converting
            ? {}
            : { expenseAccountId: orNull(expenseAccountId) }),
      })
    ).item;

    if (converting) {
      await createStockItemFromProduct(item.id, {
        assetAccountId: orNull(assetAccountId),
        cogsAccountId: orNull(cogsAccountId),
        ...(values.opening === undefined ? {} : { opening: values.opening }),
      });
      updated = (await getItem(item.id)).item;
    }
    return updated;
  }

  const title = editing ? `Edit ${item.name}` : 'New product or service';

  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/50 p-4 overflow-y-auto"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-form-title"
        onSubmit={(e) => void handleSubmit(e)}
        className="animate-pop-in w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-4 shadow-[var(--shadow-lg)]"
      >
        <h3 id="product-form-title" className="text-base font-semibold m-0">
          {title}
        </h3>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1 min-w-48">
            <span className="text-[var(--muted)]">Name</span>
            <input
              ref={nameRef}
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm w-40">
            <span className="text-[var(--muted)]">Code</span>
            <input
              required
              maxLength={40}
              value={effectiveCode}
              disabled={editing}
              title={editing ? 'A code cannot change once created' : undefined}
              onChange={(e) => {
                setCodeTouched(true);
                setCode(e.target.value.toUpperCase());
              }}
              className={inputClass}
            />
          </label>
        </div>

        {!editing && (
          <fieldset className="flex flex-wrap gap-4 text-sm border-0 p-0 m-0">
            <legend className="sr-only">Kind</legend>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="kind" checked={!isService} onChange={() => setIsService(false)} />
              Product (goods you buy or sell)
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="kind"
                checked={isService}
                onChange={() => {
                  setIsService(true);
                  setTrack(false);
                }}
              />
              Service
            </label>
          </fieldset>
        )}

        {!isService && (
          <label className={`flex items-start gap-2 text-sm ${canToggleTrack ? 'cursor-pointer' : ''}`}>
            <input
              type="checkbox"
              checked={track}
              disabled={!canToggleTrack}
              onChange={(e) => setTrack(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Track inventory</span>
              <span className="block text-xs text-[var(--muted)]">
                {alreadyTracked
                  ? 'Quantity on hand and cost are tracked. Bills add stock; invoices book cost of goods sold.'
                  : 'Keep count of what you hold. Bills add stock at their cost; invoices book cost of goods sold at the average cost.'}
              </span>
            </span>
          </label>
        )}

        {converting && (
          <p className="text-xs rounded-md bg-[var(--accent-soft)] px-3 py-2 m-0">
            From now on, bills for this product add stock and invoices book its cost. Documents already posted stay as
            they are.
          </p>
        )}

        <section className="flex flex-col gap-2" aria-labelledby="purchase-heading">
          <h4 id="purchase-heading" className={`text-xs uppercase tracking-wide m-0 ${context === 'purchase' ? 'text-[var(--text)]' : 'text-[var(--muted)]'}`}>
            I purchase this
          </h4>
          <div className="flex flex-wrap gap-3">
            <MoneyInput label="Purchase price" value={purchasePrice} onChange={setPurchasePrice} />
            <RateInput label="Tax %" value={purchaseTax} onChange={setPurchaseTax} />
            {!track && (
              <AccountSelect
                label="Expense account"
                value={expenseAccountId}
                onChange={setExpenseAccountId}
                accounts={expenseAccounts}
                emptyLabel="None"
              />
            )}
          </div>
        </section>

        <section className="flex flex-col gap-2" aria-labelledby="sale-heading">
          <h4 id="sale-heading" className={`text-xs uppercase tracking-wide m-0 ${context === 'sale' ? 'text-[var(--text)]' : 'text-[var(--muted)]'}`}>
            I sell this
          </h4>
          <div className="flex flex-wrap gap-3">
            <MoneyInput label="Sale price" value={salePrice} onChange={setSalePrice} />
            <RateInput label="Tax %" value={saleTax} onChange={setSaleTax} />
            <AccountSelect
              label="Revenue account"
              value={revenueAccountId}
              onChange={setRevenueAccountId}
              accounts={revenueAccounts}
              emptyLabel="None"
            />
          </div>
        </section>

        {showOpening && (
          <section className="flex flex-col gap-2" aria-labelledby="opening-heading">
            <h4 id="opening-heading" className="text-xs uppercase tracking-wide m-0 text-[var(--muted)]">
              Opening stock <span className="normal-case tracking-normal">(optional)</span>
            </h4>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm w-28">
                <span className="text-[var(--muted)]">Quantity</span>
                <input
                  inputMode="decimal"
                  placeholder="0"
                  value={openingQty}
                  onChange={(e) => setOpeningQty(e.target.value)}
                  className={`${inputClass} text-right tabular-nums`}
                />
              </label>
              <MoneyInput
                label="Unit cost"
                value={openingCost}
                onChange={setOpeningCost}
                placeholder={purchasePrice.trim() === '' ? formatCents(0) : purchasePrice}
              />
              <label className="flex flex-col gap-1 text-sm w-40">
                <span className="text-[var(--muted)]">As of</span>
                <input
                  type="date"
                  max={todayIsoDate()}
                  value={openingDate}
                  onChange={(e) => setOpeningDate(e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>
            <p className="text-xs text-[var(--muted)] m-0">
              What you already hold. Unit cost defaults to the purchase price. Posts to your inventory account against
              opening balances.
            </p>
          </section>
        )}

        {track && (
          <details className="text-sm">
            <summary className="cursor-pointer text-[var(--muted)]">Inventory accounts</summary>
            <div className="flex flex-wrap gap-3 mt-2">
              <AccountSelect
                label="Inventory asset account"
                value={assetAccountId}
                onChange={setAssetAccountId}
                accounts={assetAccounts}
                emptyLabel="Default"
              />
              <AccountSelect
                label="Cost of goods sold account"
                value={cogsAccountId}
                onChange={setCogsAccountId}
                accounts={expenseAccounts}
                emptyLabel="Default"
              />
            </div>
          </details>
        )}

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[var(--muted)]">Description</span>
          <textarea
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={inputClass}
          />
        </label>

        {error !== null && (
          <p role="alert" className="status status--bad m-0">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn--ghost">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || name.trim() === '' || effectiveCode.trim() === ''}
            className={primaryButtonClass}
          >
            {busy ? 'Saving…' : context !== undefined ? 'Create and use' : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
