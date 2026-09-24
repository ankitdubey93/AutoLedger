import { Plus } from 'lucide-react';
import { useAppBasePath } from '../../apps/useAppBasePath';
import Menu from '../../components/ui/Menu';

/**
 * The single entry point for "start something new" across LedgerCore — an
 * invoice, a journal entry, a customer, an account — rather than a scattered
 * button per page.
 *
 * Rendered inside the suite sidebar (LedgerCoreSidebar / AppSidebar), which
 * lives under AppFrame — the same shell every app's sidebar mounts inside —
 * so its targets are pinned to LedgerCore's own base path rather than
 * whatever app happens to be open.
 *
 * Phase 31: built on the shared `Menu` primitive (arrow keys, focus return,
 * outside-click) instead of its own hand-rolled outside-click effect.
 */
export default function CreateMenu() {
  const base = useAppBasePath();

  const items = [
    { label: 'Invoice', to: `${base}/invoices/new` },
    { label: 'Expense', to: `${base}/expenses/new` },
    { label: 'Journal entry', to: `${base}/journals/new` },
    { label: 'Customer', to: `${base}/customers?new=1` },
    { label: 'Vendor', to: `${base}/vendors?new=1` },
    { label: 'Item', to: `${base}/items?new=1` },
    { label: 'Account', to: `${base}/accounts?new=1` },
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
