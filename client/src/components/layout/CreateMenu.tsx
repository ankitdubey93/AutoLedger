import { Plus } from 'lucide-react';
import Menu from '../ui/Menu';

/**
 * The single entry point for "start something new" anywhere in the product
 * (an invoice, a bill, a stock item, a journal entry) rather than a
 * scattered button per page. Rendered at the top of the sidebar.
 *
 * Built on the shared `Menu` primitive (arrow keys, focus return,
 * outside-click).
 */
export default function CreateMenu() {

  const items = [
    { label: 'Invoice', to: '/invoices/new' },
    { label: 'Expense', to: '/expenses/new' },
    { label: 'Upload a bill', to: '/inbox' },
    { label: 'Journal entry', to: '/journals/new' },
    { label: 'Customer', to: '/customers?new=1' },
    { label: 'Vendor', to: '/vendors?new=1' },
    { label: 'Product or service', to: '/products?new=1' },
    { label: 'Stock item', to: '/inventory/items/new' },
    { label: 'Account', to: '/accounts?new=1' },
  ];

  return (
    <Menu
      panelLabel="Create new"
      align="left"
      panelClassName="right-0 w-auto"
      items={items}
      trigger={({ buttonProps }) => (
        <button
          {...buttonProps}
          type="button"
          className="flex w-full items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] transition-colors"
        >
          <Plus size={15} aria-hidden="true" /> New
        </button>
      )}
    />
  );
}
