import { formatQuantity } from '../../utils/money';
import type { Item, ItemType, StockLocation, StockProductBalance } from '../../services/fetchServices';

/**
 * The item select on invoice and bill lines (Phase 32): every product in one
 * list, grouped by type. INVENTORY products show their on-hand quantity;
 * lot- and serial-tracked ones and fixed assets are listed but disabled with a
 * reason (lot/serial picking and asset capitalisation on document lines are the
 * next step).
 */

const GROUPS: { type: ItemType; label: string }[] = [
  { type: 'SERVICE', label: 'Services' },
  { type: 'NON_INVENTORY', label: 'Non-inventory' },
  { type: 'INVENTORY', label: 'Inventory' },
  { type: 'FIXED_ASSET', label: 'Fixed assets' },
];

function disabledReason(item: Item, balance: StockProductBalance | undefined): string | null {
  if (item.itemType === 'FIXED_ASSET') return 'not yet supported on documents';
  if (item.itemType === 'INVENTORY' && balance !== undefined && balance.tracking !== 'QUANTITY') {
    return `${balance.tracking.toLowerCase()}-tracked — not yet supported on documents`;
  }
  return null;
}

export function isInventoryItem(item: Item | undefined): boolean {
  return item?.itemType === 'INVENTORY';
}

const QUICK_ADD = '__quick_add__';

export function ProductPicker({
  value,
  items,
  balances,
  onChange,
  onQuickAdd,
  ariaLabel,
  className,
}: {
  value: string;
  items: Item[];
  balances: Map<string, StockProductBalance>;
  onChange: (itemId: string) => void;
  /** When given, the list ends with a "＋ New product or service…" entry that calls this instead of onChange. */
  onQuickAdd?: () => void;
  ariaLabel: string;
  className: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === QUICK_ADD) {
          onQuickAdd?.();
          return;
        }
        onChange(e.target.value);
      }}
      aria-label={ariaLabel}
      className={className}
    >
      <option value="">Free text</option>
      {GROUPS.map((group) => {
        const inGroup = items.filter((item) => item.itemType === group.type);
        if (inGroup.length === 0) return null;
        return (
          <optgroup key={group.type} label={group.label}>
            {inGroup.map((item) => {
              const balance = balances.get(item.id);
              const reason = disabledReason(item, balance);
              const onHand =
                item.itemType === 'INVENTORY' && balance !== undefined
                  ? ` · ${formatQuantity(balance.onHandQuantityMilli)} ${balance.uomCode} on hand`
                  : '';
              return (
                <option key={item.id} value={item.id} disabled={reason !== null && item.id !== value}>
                  {item.code} · {item.name}
                  {onHand}
                  {reason === null ? '' : ` (${reason})`}
                </option>
              );
            })}
          </optgroup>
        );
      })}
      {onQuickAdd !== undefined && <option value={QUICK_ADD}>＋ New product or service…</option>}
    </select>
  );
}

/** Location select shown under the picker on an INVENTORY line. Empty = the default location. */
export function LineLocationSelect({
  value,
  locations,
  defaultLocationId,
  onChange,
  ariaLabel,
  className,
}: {
  value: string;
  locations: StockLocation[];
  defaultLocationId: string | null;
  onChange: (locationId: string) => void;
  ariaLabel: string;
  className: string;
}) {
  const defaultLocation = locations.find((l) => l.id === defaultLocationId);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel} className={className}>
      <option value="">
        {defaultLocation === undefined ? 'Stock location…' : `Default · ${defaultLocation.code}`}
      </option>
      {locations.map((location) => (
        <option key={location.id} value={location.id}>
          {location.code} · {location.name}
        </option>
      ))}
    </select>
  );
}
