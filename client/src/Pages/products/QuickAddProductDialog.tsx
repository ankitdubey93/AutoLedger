import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, createItem, type Account, type Item } from '../../services/fetchServices';
import { formatCents, parseCentsInput } from '../../utils/money';

/**
 * "Quick add" from an invoice or bill line (Phase 32): create a SERVICE or
 * NON_INVENTORY product without leaving the document you are drafting. It is a
 * help tool, not a second catalogue — it calls the same `POST /items`
 * as Products & Services, and the new item is then picked on the line like any
 * other. Inventory items are deliberately not offered: stock needs a unit,
 * tracking and a location, which Inventory owns.
 *
 * The code is derived from the name (`Web design` → `WEB-DESIGN`) so the common
 * case is two fields; if the derived code is taken it retries with `-2`, `-3`
 * … A code the person typed themselves is never silently changed.
 */

const inputClass =
  'bg-[var(--bg)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-sm text-[var(--text)] w-full';

export function deriveItemCode(name: string): string {
  const code = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return code === '' ? 'ITEM' : code;
}

const MAX_CODE_ATTEMPTS = 6;

export default function QuickAddProductDialog({
  mode,
  accounts,
  defaultAccountId,
  onCreated,
  onCancel,
}: {
  /** `sale` on an invoice (revenue account, sale price); `purchase` on a bill (expense account, purchase price). */
  mode: 'sale' | 'purchase';
  accounts: Account[];
  defaultAccountId: string;
  onCreated: (item: Item) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [itemType, setItemType] = useState<'SERVICE' | 'NON_INVENTORY'>('SERVICE');
  const [price, setPrice] = useState('');
  const [accountId, setAccountId] = useState(accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : '');
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

  const effectiveCode = codeTouched ? code : deriveItemCode(name);
  const priceCents = price.trim() === '' ? null : parseCentsInput(price);
  const priceInvalid = price.trim() !== '' && priceCents === null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // This dialog is rendered from inside the invoice/bill form. The portal below fixes the
    // DOM nesting, but React still bubbles synthetic events through the React tree — without
    // this, "Create and use" would also submit the draft document.
    event.stopPropagation();
    if (priceInvalid) {
      setError('Price must be an amount like 12.50');
      return;
    }
    setBusy(true);
    setError(null);

    const base = effectiveCode.trim();
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 1 ? base : `${base.slice(0, 36)}-${String(attempt)}`;
      try {
        const res = await createItem({
          code: candidate,
          name: name.trim(),
          description: null,
          itemType,
          salePriceCents: mode === 'sale' ? priceCents : null,
          purchasePriceCents: mode === 'purchase' ? priceCents : null,
          revenueAccountId: mode === 'sale' && accountId !== '' ? accountId : null,
          expenseAccountId: mode === 'purchase' && accountId !== '' ? accountId : null,
          saleTaxRateBp: 0,
          purchaseTaxRateBp: 0,
        });
        onCreated(res.item);
        return;
      } catch (err: unknown) {
        const taken = err instanceof ApiRequestError && err.status === 409;
        if (taken && !codeTouched && attempt < MAX_CODE_ATTEMPTS) continue;
        setError(
          taken
            ? `The code ${candidate} is already used — choose another`
            : err instanceof Error
              ? err.message
              : 'Could not create the item',
        );
        setBusy(false);
        return;
      }
    }
  }

  const accountLabel = mode === 'sale' ? 'Revenue account' : 'Expense account';
  const priceLabel = mode === 'sale' ? 'Sale price' : 'Purchase price';

  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-add-title"
        onSubmit={(e) => void handleSubmit(e)}
        className="animate-pop-in w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 flex flex-col gap-3 shadow-[var(--shadow-lg)]"
      >
        <h3 id="quick-add-title" className="text-base font-semibold m-0">
          New product or service
        </h3>
        <p className="text-xs text-[var(--muted)] m-0">
          Saved to Products &amp; Services and picked on this line. To track quantity, create a{' '}
          <a href="/inventory/items/new" target="_blank" rel="noreferrer" className="underline">
            stock item
          </a>{' '}
          instead.
        </p>

        <label className="flex flex-col gap-1 text-sm">
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

        <div className="flex gap-3">
          <label className="flex flex-col gap-1 text-sm flex-1">
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
          <label className="flex flex-col gap-1 text-sm w-32">
            <span className="text-[var(--muted)]">Code</span>
            <input
              maxLength={40}
              value={effectiveCode}
              onChange={(e) => {
                setCodeTouched(true);
                setCode(e.target.value.toUpperCase());
              }}
              className={inputClass}
            />
          </label>
        </div>

        <div className="flex gap-3">
          <label className="flex flex-col gap-1 text-sm w-36">
            <span className="text-[var(--muted)]">{priceLabel}</span>
            <input
              inputMode="decimal"
              placeholder={formatCents(0)}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={`${inputClass} text-right tabular-nums`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm flex-1">
            <span className="text-[var(--muted)]">{accountLabel}</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
              <option value="">None</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </label>
        </div>

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
            className="px-4 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Creating…' : 'Create and use'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
