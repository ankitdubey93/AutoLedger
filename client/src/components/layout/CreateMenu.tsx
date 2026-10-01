import { Plus } from 'lucide-react';
import Menu from '../ui/Menu';
import { useCan } from '../../context/AuthContext';

/**
 * The single entry point for "start something new" anywhere in the product
 * (an invoice, a bill, a stock item, a journal entry) rather than a
 * scattered button per page. Rendered at the top of the sidebar.
 *
 * Built on the shared `Menu` primitive (arrow keys, focus return,
 * outside-click).
 */
const ITEMS = [
  { label: 'Invoice', to: '/invoices/new', permission: 'invoices.edit' },
  { label: 'Expense', to: '/expenses/new', permission: 'bills.edit' },
  { label: 'Upload a bill', to: '/inbox', permission: 'capture.process' },
  { label: 'Journal entry', to: '/journals/new', permission: 'journals.create' },
  { label: 'Customer', to: '/customers?new=1', permission: 'customers.manage' },
  { label: 'Vendor', to: '/vendors?new=1', permission: 'vendors.manage' },
  { label: 'Product or service', to: '/products?new=1', permission: 'products.manage' },
  { label: 'Tracked product', to: '/products?new=1&track=1', permission: 'inventory.operate' },
  { label: 'Account', to: '/accounts?new=1', permission: 'accounts.manage' },
];

export default function CreateMenu() {
  // Phase 38c — offer only what this member can create; a read-only role sees no "New" button at all.
  const can = useCan();
  const items = ITEMS.filter((item) => can(item.permission)).map(({ label, to }) => ({ label, to }));
  if (items.length === 0) return null;

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
